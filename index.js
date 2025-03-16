require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ApplicationCommandOptionType, REST, Routes } = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Configuration
const config = {
  discordToken: process.env.DISCORD_TOKEN,
  discordAppId: process.env.DISCORD_APP_ID,
  refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 60000, // Default to 1 minute
};

// File to store server configurations
const SERVER_CONFIG_FILE = 'server-configs.json';

// Server configurations map
let serverConfigs = {};

// Store the last processed sale IDs to avoid duplicates
const lastProcessedSales = {
  magicEden: new Map() // Changed from Set to Map to store timestamp with ID
};

// Max number of sale IDs to remember (to prevent memory leaks)
const MAX_CACHE_SIZE = 20; // Reduced from 100 to only keep recent sales

// Slash commands definition
const commands = [
  {
    name: 'setchannel',
    description: 'Set the current channel for NFT sale notifications (Admin only)'
  },
  {
    name: 'track',
    description: 'Start tracking sales for a specific collection',
    options: [
      {
        name: 'collection',
        description: 'Collection address or Magic Eden URL',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'untrack',
    description: 'Stop tracking sales for a specific collection',
    options: [
      {
        name: 'collection',
        description: 'Collection address or Magic Eden URL',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: 'list',
    description: 'Show all currently tracked collections'
  },
  {
    name: 'help',
    description: 'Show all available commands'
  }
];

// Function to register slash commands
async function registerSlashCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    
    await rest.put(
      Routes.applicationCommands(config.discordAppId),
      { body: commands }
    );
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
}

// Load server configurations from file
function loadServerConfigs() {
  try {
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
      const data = fs.readFileSync(SERVER_CONFIG_FILE, 'utf8');
      serverConfigs = JSON.parse(data);
      console.log(`Loaded configurations for ${Object.keys(serverConfigs).length} servers`);
    } else {
      serverConfigs = {};
      console.log('No server configuration file found. Creating new configuration.');
      saveServerConfigs();
    }
  } catch (error) {
    console.error('Error loading server configurations:', error);
    serverConfigs = {};
  }
}

// Save server configurations to file
function saveServerConfigs() {
  try {
    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(serverConfigs, null, 2), 'utf8');
    console.log('Server configurations saved successfully');
  } catch (error) {
    console.error('Error saving server configurations:', error);
  }
}

// Initialize server configuration if it doesn't exist
function initServerConfig(guildId) {
  if (!serverConfigs[guildId]) {
    serverConfigs[guildId] = {
      notificationChannelId: null,
      trackedCollections: {}  // Changed to object with address as key, metadata as value
    };
    saveServerConfigs();
  } else if (Array.isArray(serverConfigs[guildId].trackedCollections)) {
    // Convert old format (array) to new format (object)
    const oldCollections = [...serverConfigs[guildId].trackedCollections];
    serverConfigs[guildId].trackedCollections = {};
    oldCollections.forEach(address => {
      serverConfigs[guildId].trackedCollections[address] = { 
        address: address,
        source: 'Unknown',
        addedAt: new Date().toISOString()
      };
    });
    saveServerConfigs();
  }
  return serverConfigs[guildId];
}

// Function to extract collection address from input (Magic Eden URL or direct address)
function extractCollectionAddress(input) {
  if (!input) return null;
  
  // Clean the input (trim whitespace, remove quotes)
  const cleanedInput = input.trim().replace(/^["']|["']$/g, '');
  
  // Try to match Magic Eden URL format
  const meUrlPattern = /magiceden\.io\/collections\/monad-testnet\/([^\/\s]+)/;
  const meMatch = cleanedInput.match(meUrlPattern);
  
  if (meMatch && meMatch[1]) {
    return {
      address: meMatch[1],
      source: 'Magic Eden',
      url: cleanedInput
    };
  }
  
  // If it's not a URL but a direct address, return it
  // This now also handles if someone pasted a full URL into untrack command
  if (cleanedInput.startsWith('0x')) {
    return {
      address: cleanedInput,
      source: 'Direct Address'
    };
  }
  
  // If unable to extract, return null
  return null;
}

// Function to fetch collection info from Magic Eden with retries
async function fetchCollectionInfo(collectionAddress) {
  const MAX_RETRIES = 3;
  let attempts = 0;
  let lastError = null;
  
  // Collection info cache to prevent repeated API calls
  if (!global.collectionInfoCache) {
    global.collectionInfoCache = new Map();
  }
  
  // Make sure we're only using the address part, not a full URL
  if (collectionAddress.includes('magiceden.io')) {
    const extracted = extractCollectionAddress(collectionAddress);
    if (extracted) {
      collectionAddress = extracted.address;
    }
  }
  
  // Check if we have cached info for this collection
  if (global.collectionInfoCache.has(collectionAddress)) {
    return global.collectionInfoCache.get(collectionAddress);
  }
  
  // Get Magic Eden API key from environment
  const apiKey = process.env.MAGIC_EDEN_API_KEY || '';
  const hasApiKey = apiKey && apiKey !== 'YOUR_API_KEY';
  
  // Define the chain parameter
  const chain = "monad-testnet";
  
  // Try Magic Eden API v7
  while (attempts < MAX_RETRIES) {
    try {
      console.log(`Fetching collection info for ${collectionAddress} (attempt ${attempts + 1}/${MAX_RETRIES})`);
      
      // Setup request options with Authorization header if API key exists
      const options = {
        timeout: 10000, // 10 second timeout
        headers: {
          'accept': '*/*'
        }
      };
      
      // Add Authorization header if we have an API key
      if (hasApiKey) {
        options.headers['Authorization'] = `Bearer ${apiKey}`;
        console.log('Using API key for collection info requests');
      } else {
        console.log('No API key found - using public access for collection info');
      }
      
      // Using the correct endpoint with chain parameter and filtering by id
      const v7Url = `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7?id=${collectionAddress}`;
      console.log(`Trying Magic Eden v7 API: ${v7Url}`);
      
      const v7Response = await axios.get(v7Url, options);
      
      if (v7Response.data && v7Response.data.collections && v7Response.data.collections.length > 0) {
        // Get the first matching collection
        const collectionData = v7Response.data.collections[0];
        
        console.log(`Found collection in v7 API: ${collectionData.name}`);
        
        const info = {
          name: collectionData.name || `Monad Collection ${collectionAddress.substring(0, 6)}...`,
          symbol: collectionData.symbol || null,
          image: collectionData.image || null,
          description: collectionData.description || null,
          floorPrice: collectionData.floorSale?.['1day'] || null,
          volume24hr: collectionData.volume?.['1day'] || null,
          ownerCount: collectionData.ownerCount || null
        };
        
        // Cache the result
        global.collectionInfoCache.set(collectionAddress, info);
        
        return info;
      } else {
        console.log(`Collection ${collectionAddress} not found in v7 API, will try v2 API`);
      }
      
      // Fallback to v2 API if collection not found in v7
      const v2Url = `https://api-mainnet.magiceden.dev/v2/${chain}/collections/${collectionAddress}`;
      console.log(`Trying Magic Eden v2 API: ${v2Url}`);
      
      const v2Response = await axios.get(v2Url, options);
      
      if (v2Response.data) {
        const info = {
          name: v2Response.data.name || `Monad Collection ${collectionAddress.substring(0, 6)}...`,
          symbol: v2Response.data.symbol || null,
          image: v2Response.data.image || null,
          description: v2Response.data.description || null,
          floorPrice: v2Response.data.floorPrice,
          volume24hr: v2Response.data.volume24hr
        };
        
        // Cache the result
        global.collectionInfoCache.set(collectionAddress, info);
        
        return info;
      }
    } catch (error) {
      lastError = error;
      console.log(`Error fetching collection info (attempt ${attempts + 1}): ${error.message}`);
      
      if (error.response) {
        console.log(`Status: ${error.response.status}, Data:`, error.response.data);
      }
      
      attempts++;
      
      // Wait before retrying (exponential backoff)
      if (attempts < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempts);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  console.error(`Failed to fetch collection info after ${MAX_RETRIES} retries:`, lastError?.message);
  
  // Try alternative approach: get collection name from Monad explorer if available
  try {
    console.log(`Trying to fetch collection info from Monad Explorer for ${collectionAddress}`);
    const explorerResponse = await axios.get(`https://explorer.monad.network/api/v2/tokens/${collectionAddress}/instances`, {
      timeout: 5000
    });
    
    if (explorerResponse.data && explorerResponse.data.items && explorerResponse.data.items.length > 0) {
      // Try to extract name from token data
      const tokenData = explorerResponse.data.items[0];
      let name = tokenData.name || tokenData.collection?.name || null;
      
      if (name) {
        const info = {
          name: name,
          image: null,
          description: null
        };
        
        global.collectionInfoCache.set(collectionAddress, info);
        return info;
      }
    }
  } catch (explorerError) {
    console.log(`Error fetching from Monad Explorer: ${explorerError.message}`);
  }
  
  // If we can't get info, still cache a minimal result with better naming
  const fallbackInfo = {
    name: `Monad Collection ${collectionAddress.substring(0, 6)}...`,
    image: null,
    description: null
  };
  
  global.collectionInfoCache.set(collectionAddress, fallbackInfo);
  
  return fallbackInfo;
}

// Function to fetch sales through collection stats monitoring
async function monitorCollectionStats(collections) {
  if (!collections || Object.keys(collections).length === 0) {
    console.log("No collections to monitor");
    return [];
  }

  const collectionAddresses = Object.keys(collections).map(key => {
    return collections[key].address;
  });
  
  console.log("Monitoring collections:", collectionAddresses);
  
  // Create a static object to store previous stats
  if (!global.previousCollectionStats) {
    global.previousCollectionStats = new Map();
  }
  
  // Store all detected sales here
  const detectedSales = [];
  
  // Check each collection for changes
  for (const address of collectionAddresses) {
    try {
      console.log(`Checking stats for collection: ${address}`);
      
      // Fetch current collection info/stats
      const chain = "monad-testnet";
      const url = `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7?id=${address}`;
      
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'accept': '*/*' }
      });
      
      if (!response.data || !response.data.collections || !response.data.collections.length) {
        console.log(`No data found for collection ${address}`);
        continue;
      }
      
      const collectionData = response.data.collections[0];
      console.log(`Got data for collection: ${collectionData.name}`);
      
      // Extract stats that might indicate sales
      const currentStats = {
        volume: collectionData.volume?.['1day'] || 0,
        floorPrice: collectionData.floorSale?.['1day'] || 0,
        salesCount: collectionData.salesCount || 0,
        updatedAt: collectionData.updatedAt,
        lastChecked: new Date().toISOString()
      };
      
      // Get previous stats for comparison
      const previousStats = global.previousCollectionStats.get(address);
      
      // If we have previous stats, check for changes
      if (previousStats) {
        console.log(`Comparing with previous stats from ${previousStats.lastChecked}`);
        
        // If any stats have increased, we assume there was a sale
        const volumeIncreased = currentStats.volume > previousStats.volume;
        const salesCountIncreased = currentStats.salesCount > previousStats.salesCount;
        
        // Only create a sale notification if certain stat changes are detected
        if (volumeIncreased || salesCountIncreased) {
          console.log(`🔔 SALE DETECTED for ${collectionData.name}!`);
          console.log(`Volume change: ${previousStats.volume} -> ${currentStats.volume}`);
          console.log(`Sales count change: ${previousStats.salesCount} -> ${currentStats.salesCount}`);
          
          // Create a synthetic sale object with the available information
          const syntheticSale = {
            collection: {
              id: address,
              name: collectionData.name
            },
            price: (currentStats.volume - previousStats.volume).toFixed(4),
            type: 'Sale',
            createdAt: new Date().toISOString(),
            id: `synthetic_${address}_${Date.now()}`, // Create unique ID for this synthetic sale
            token: {
              image: collectionData.image
            }
          };
          
          detectedSales.push(syntheticSale);
        } else {
          console.log(`No sales detected for ${collectionData.name}`);
        }
      } else {
        console.log(`First time checking ${collectionData.name}, establishing baseline stats`);
      }
      
      // Update the stored stats for next comparison
      global.previousCollectionStats.set(address, currentStats);
      
    } catch (error) {
      console.error(`Error monitoring stats for collection ${address}:`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data));
      }
    }
  }
  
  return detectedSales;
}

// Function to create a Discord embed for sale notification
function createSaleEmbed(sale) {
  // Get collection name, prioritizing v3 API format first
  const collectionName = sale.collection?.name || 
                         sale.collection?.id || 
                         sale.collection || 
                         sale.collectionAddress || 
                         'Unknown Collection';
                         
  // Get token ID from v3 or v2 format                       
  const tokenId = sale.token?.mintAddress || 
                  sale.token?.tokenMint || 
                  sale.tokenMint || 
                  sale.tokenId || 
                  sale.nft?.tokenId || 
                  sale.token_id || 
                  'Unknown';
                  
  // Get price from v3 or v2 format
  const price = sale.price || 
                sale.amount || 
                sale.value || 
                (sale.sale?.amount ? parseFloat(sale.sale.amount) / 1e9 : null) || 
                'Unknown';
  
  let embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`New Sale: ${collectionName}`)
    .setTimestamp()
    .setFooter({ text: 'Source: Magic Eden' });

  // Add fields based on the available data
  if (tokenId) {
    embed.addFields({ name: 'Token ID', value: `${tokenId}`, inline: true });
  }
  
  if (price) {
    embed.addFields({ name: 'Price', value: `${price} MONAD`, inline: true });
  }
  
  // Get seller from v3 or v2 format
  const seller = sale.seller || 
                 sale.from || 
                 sale.wallets?.seller || 
                 sale.sale?.sellerAddress;
                 
  if (seller) {
    embed.addFields({ name: 'Seller', value: shortenAddress(seller), inline: true });
  }
  
  // Get buyer from v3 or v2 format
  const buyer = sale.buyer || 
                sale.to || 
                sale.wallets?.buyer || 
                sale.sale?.buyerAddress;
                
  if (buyer) {
    embed.addFields({ name: 'Buyer', value: shortenAddress(buyer), inline: true });
  }
  
  if (sale.marketplace) {
    embed.addFields({ name: 'Marketplace', value: sale.marketplace, inline: true });
  }
  
  // Get transaction hash from v3 or v2 format
  const txHash = sale.txHash || 
                 sale.signature || 
                 sale.transaction_hash || 
                 sale.txId;
                 
  if (txHash) {
    embed.addFields({ name: 'Transaction', value: `[View](https://explorer.monad.network/tx/${txHash})`, inline: true });
  }
  
  // Add NFT image if available
  const image = sale.token?.image || 
                sale.image || 
                sale.nft?.image || 
                sale.metadata?.image;
                
  if (image) {
    embed.setImage(image);
  }
  
  return embed;
}

// Function to create a Discord embed for collection list
function createCollectionListEmbed(collections, guildName, page = 1, itemsPerPage = 5) {
  const collectionEntries = Object.entries(collections);
  const totalCollections = collectionEntries.length;
  const totalPages = Math.ceil(totalCollections / itemsPerPage);
  
  // Ensure page is valid
  page = Math.max(1, Math.min(page, totalPages || 1));
  
  // Calculate start and end index for pagination
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalCollections);
  const pageItems = collectionEntries.slice(startIndex, endIndex);
  
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`Tracked Collections in ${guildName}`)
    .setDescription(totalCollections === 0 ? 'No collections being tracked.' : `Currently tracking ${totalCollections} collections`)
    .setTimestamp()
    .setFooter({ text: totalPages > 1 ? `Page ${page}/${totalPages}` : `${totalCollections} collections` });
  
  // Add collection entries to the embed
  for (let i = 0; i < pageItems.length; i++) {
    const [address, metadata] = pageItems[i];
    const collectionIndex = startIndex + i + 1; // Convert to 1-based index
    const addedAt = metadata.addedAt ? new Date(metadata.addedAt).toLocaleDateString() : 'Unknown';
    const name = metadata.name || '';
    
    // Determine if it's a generated address-based name or a real collection name
    const isAddressBasedName = name.includes(address.substring(0, 6)) || 
                             name.includes('Collection 0x') || 
                             name.includes('Monad Collection');
    
    // Create display name based on whether it has a real name
    let displayName;
    if (isAddressBasedName || !name) {
      displayName = `Collection ${collectionIndex}`;
    } else {
      displayName = name;
    }
    
    // Create Magic Eden URL
    const meUrl = `https://magiceden.io/collections/monad-testnet/${address}`;
    
    // Create a concise value with the important info - always include the address
    let value = `Address: \`${address.substring(0, 8)}...\`\n[View on ME](${meUrl}) • Added: ${addedAt}`;
    
    // Set the field name based on our logic above
    embed.addFields({ name: `${collectionIndex}. ${displayName}`, value: value });
  }
  
  return { embed, currentPage: page, totalPages };
}

// Helper function to shorten blockchain addresses
function shortenAddress(address) {
  if (!address) return 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

// Function to process new sales and send notifications
async function processSales() {
  try {
    console.log("=================== PROCESSING SALES ===================");
    debugCacheStatus(); // Add this line to show cache status
    
    // Track if we found any sales
    let salesFound = false;
    let notificationsSent = 0;
    
    // Clean up old cache entries (older than 1 hour)
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [saleId, timestamp] of lastProcessedSales.magicEden.entries()) {
      if (now - timestamp > ONE_HOUR) {
        lastProcessedSales.magicEden.delete(saleId);
        console.log(`Removed old sale ID from cache: ${saleId}`);
      }
    }
    
    // Process for each server with configuration
    for (const [guildId, serverConfig] of Object.entries(serverConfigs)) {
      // Skip if no collections are being tracked or no notification channel is set
      if (!serverConfig.trackedCollections || 
          Object.keys(serverConfig.trackedCollections).length === 0 || 
          !serverConfig.notificationChannelId) {
        console.log(`Skipping guild ${guildId}: no collections tracked or no notification channel set`);
        continue;
      }

      // Get the guild and channel
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.log(`Guild not found: ${guildId}`);
        continue;
      }

      const channel = guild.channels.cache.get(serverConfig.notificationChannelId);
      if (!channel) {
        console.log(`Notification channel not found for guild: ${guild.name}`);
        continue;
      }

      console.log(`Processing sales for guild: ${guild.name}`);
      console.log(`Total tracked collections: ${Object.keys(serverConfig.trackedCollections).length}`);

      // Try to update collection info periodically 
      // (do this roughly every hour - based on a random chance)
      if (Math.random() < 0.02) { // ~2% chance each run = ~once per hour if runs every minute
        await updateCollectionInfo(guildId);
      }

      try {
        // Process Magic Eden sales using the new collection stats monitoring approach
        console.log("Monitoring collection stats for sales detection...");
        const magicEdenSales = await monitorCollectionStats(serverConfig.trackedCollections);
        console.log(`Detected ${magicEdenSales.length} potential sales via stats monitoring`);
        
        // Sort sales by timestamp if available to process oldest first
        magicEdenSales.sort((a, b) => {
          const timeA = a.blockTime || a.createdAt || 0;
          const timeB = b.blockTime || b.createdAt || 0;
          return timeA - timeB;
        });
        
        if (magicEdenSales.length > 0) {
          salesFound = true;
          
          // Log all sales found
          console.log("Sales detected:");
          magicEdenSales.forEach((sale, index) => {
            const collectionId = sale.collection?.id || 
                               sale.collection?.tokenMint || 
                               sale.tokenMint || 
                               sale.collection ||
                               'unknown';
            
            const saleId = sale.id || 'unknown';
                          
            const timestamp = sale.blockTime || sale.createdAt || Date.now();
            
            console.log(`Sale ${index + 1}/${magicEdenSales.length}:`, 
              `collection=${collectionId}`, 
              `saleId=${saleId}`,
              `time=${new Date(timestamp).toISOString()}`,
              `processed=${lastProcessedSales.magicEden.has(saleId)}`);
          });
        } else {
          console.log("No sales detected from collection stats");
        }
        
        // Examine each sale
        for (const sale of magicEdenSales) {
          // Extract unique ID for sales
          const saleId = sale.id || `synthetic_${sale.collection?.id}_${Date.now()}`;
          
          // Get timestamp from sale or use current time
          const timestamp = sale.blockTime || sale.createdAt || Date.now();
          const saleTime = new Date(timestamp).toISOString();
          
          console.log(`Processing sale with ID: ${saleId} from ${saleTime}`);
          console.log(`Already processed? ${lastProcessedSales.magicEden.has(saleId)}`);
          
          // If we haven't processed this sale in the cache period
          if (saleId && !lastProcessedSales.magicEden.has(saleId)) {
            // Add to processed map with current timestamp
            lastProcessedSales.magicEden.set(saleId, Date.now());
            console.log(`Added sale ID to processed cache: ${saleId}`);
            console.log(`Cache size now: ${lastProcessedSales.magicEden.size}`);
            
            // Trim cache if needed
            if (lastProcessedSales.magicEden.size > MAX_CACHE_SIZE) {
              // Get oldest entry (first item)
              const oldestKey = Array.from(lastProcessedSales.magicEden.keys())[0];
              lastProcessedSales.magicEden.delete(oldestKey);
              console.log(`Trimmed oldest sale from cache: ${oldestKey}`);
              console.log(`Cache size after trim: ${lastProcessedSales.magicEden.size}`);
            }
            
            // Send notification to Discord
            console.log("Creating embed for sale notification");
            const embed = createSaleEmbed(sale);
            
            const collectionName = sale.collection?.name || 
                                 sale.collection?.id || 
                                 sale.collection || 
                                 'Unknown Collection';
            
            console.log(`🔔 SENDING NOTIFICATION for ${collectionName} sale (${saleId})`);
            await channel.send({ embeds: [embed] });
            console.log(`✅ NOTIFICATION SENT SUCCESSFULLY for ${collectionName}!`);
            notificationsSent++;
          } else {
            console.log(`Skipping sale ID ${saleId} - already processed or missing ID`);
          }
        }
      } catch (error) {
        console.error(`Error processing Magic Eden sales for guild ${guild.name}:`, error.message);
        console.error("Full error:", error);
      }
    }
    
    if (!salesFound) {
      console.log("No sales found across all guilds");
    } else {
      console.log(`🔔 SALES PROCESSING COMPLETE - Sent ${notificationsSent} notifications`);
    }
    
    console.log("=================== PROCESSING COMPLETE ===================");
  } catch (error) {
    console.error("Error in processSales:", error.message);
    console.error("Full error:", error);
  }
}

// Check if user has admin permissions
function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

// Function to update existing tracked collections with fresh info
async function updateCollectionInfo(guildId) {
  if (!serverConfigs[guildId] || !serverConfigs[guildId].trackedCollections) {
    return;
  }
  
  const collections = serverConfigs[guildId].trackedCollections;
  
  for (const [address, metadata] of Object.entries(collections)) {
    if (metadata.name === 'Unknown Collection' || !metadata.name) {
      try {
        console.log(`Updating info for collection ${address}`);
        // Make sure we're only using the address part
        let collectionAddress = address;
        if (collectionAddress.includes('magiceden.io')) {
          const extracted = extractCollectionAddress(collectionAddress);
          if (extracted) {
            collectionAddress = extracted.address;
          }
        }
        
        const collectionInfo = await fetchCollectionInfo(collectionAddress);
        if (collectionInfo && collectionInfo.name) {
          collections[address] = {
            ...metadata,
            address: collectionAddress, // Store the clean address
            name: collectionInfo.name,
            image: collectionInfo.image || metadata.image,
            description: collectionInfo.description || metadata.description,
            floorPrice: collectionInfo.floorPrice || metadata.floorPrice,
            lastUpdated: new Date().toISOString()
          };
        }
      } catch (error) {
        console.error(`Error updating collection info for ${address}:`, error.message);
      }
    }
  }
  
  saveServerConfigs();
}

// Function to validate collection address
function validateCollectionAddress(address) {
  // Basic Ethereum address validation
  const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  return ethAddressRegex.test(address);
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;
  
  try {
    // Handle button interactions
    if (interaction.isButton()) {
      // Parse button ID (format: action_param1_param2)
      const [action, ...params] = interaction.customId.split('_');
      
      // Handle pagination buttons
      if (action === 'page') {
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return;
        }
        
        const serverConfig = initServerConfig(guildId);
        const currentPage = parseInt(params[0]) || 1;
        const newPage = params[1] === 'next' ? currentPage + 1 : currentPage - 1;
        
        // Re-create the collection list with the new page
        const { embed, currentPage: validatedPage, totalPages } = createCollectionListEmbed(
          serverConfig.trackedCollections, 
          interaction.guild.name, 
          newPage,
          5 // items per page
        );
        
        // Create navigation and action buttons
        const components = createCollectionListComponents(validatedPage, totalPages, serverConfig.trackedCollections);
        
        await interaction.update({ embeds: [embed], components });
        return;
      }
      
      // Handle untrack buttons
      if (action === 'untrack') {
        const address = params[0];
        const page = parseInt(params[1]) || 1;
        const guildId = interaction.guildId;
        
        if (!guildId) {
          await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return;
        }
        
        const serverConfig = initServerConfig(guildId);
        
        if (serverConfig.trackedCollections[address]) {
          const collectionName = serverConfig.trackedCollections[address].name || address;
          delete serverConfig.trackedCollections[address];
          saveServerConfigs();
          
          // Re-create the collection list for the current page (might need to go back a page if it was the last item)
          const { embed, currentPage: validatedPage, totalPages } = createCollectionListEmbed(
            serverConfig.trackedCollections, 
            interaction.guild.name, 
            totalPages < page ? Math.max(1, totalPages) : page, 
            5 // items per page
          );
          
          // Create updated navigation buttons
          const components = createCollectionListComponents(validatedPage, totalPages, serverConfig.trackedCollections);
          
          await interaction.update({ 
            content: `No longer tracking collection: ${collectionName}`,
            embeds: [embed], 
            components 
          });
        } else {
          await interaction.reply({ content: `Collection not found or already untracked.`, ephemeral: true });
        }
        return;
      }
    }
    
    // Handle slash commands
    if (!interaction.isCommand()) return;
    
    // Guild check
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    
    // Get or initialize server configuration
    const guildId = interaction.guildId;
    const serverConfig = initServerConfig(guildId);
    
    const { commandName, options } = interaction;
    
    switch (commandName) {
      case 'setchannel':
        // Only admins can set the notification channel
        if (!isAdmin(interaction.member)) {
          await interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: true });
          return;
        }
        
        serverConfig.notificationChannelId = interaction.channelId;
        saveServerConfigs();
        await interaction.reply({ content: `Set this channel as the notification channel for NFT sales!`, ephemeral: true });
        break;
        
      case 'track':
        // Check if notification channel is set
        if (!serverConfig.notificationChannelId) {
          await interaction.reply({ content: 'Please set a notification channel first using /setchannel', ephemeral: true });
          return;
        }
        
        const collectionInput = options.getString('collection');
        if (!collectionInput) {
          await interaction.reply({ content: 'Please provide a collection address or Magic Eden URL.', ephemeral: true });
          return;
        }
        
        // Extract collection address from input
        const collectionData = extractCollectionAddress(collectionInput);
        if (!collectionData) {
          await interaction.reply({ 
            content: 'Invalid collection address or URL format. Please provide either:\n' +
                    '• A valid Ethereum address (starting with 0x)\n' + 
                    '• A Magic Eden collection URL (https://magiceden.io/collections/monad-testnet/...)', 
            ephemeral: true 
          });
          return;
        }
        
        // Validate the extracted address
        const { address, source, url } = collectionData;
        if (!validateCollectionAddress(address)) {
          await interaction.reply({ 
            content: `The address \`${address}\` doesn't appear to be a valid Ethereum address. Please check for typos.`, 
            ephemeral: true 
          });
          return;
        }
        
        // Defer reply since collection info fetch might take time
        await interaction.deferReply({ ephemeral: true });
        
        if (serverConfig.trackedCollections[address]) {
          await interaction.editReply({ content: `Already tracking collection: ${address}`, ephemeral: true });
          return;
        }
        
        try {
          // Try to fetch collection info from Magic Eden
          const collectionInfo = await fetchCollectionInfo(address);
          
          // Add to tracked collections
          serverConfig.trackedCollections[address] = {
            address,
            source,
            url,
            name: collectionInfo?.name || 'Unknown Collection',
            image: collectionInfo?.image || null,
            description: collectionInfo?.description || null,
            floorPrice: collectionInfo?.floorPrice || null,
            addedAt: new Date().toISOString(),
            addedBy: interaction.user.id
          };
          
          saveServerConfigs();
          
          // Create embed for response
          const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`Now Tracking: ${collectionInfo?.name || address}`)
            .setDescription(`Successfully added to tracking list.`)
            .addFields(
              { name: 'Address', value: `\`${address}\``, inline: false },
              { name: 'Source', value: source, inline: true },
              { name: 'Added By', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setTimestamp();
          
          if (collectionInfo?.image) {
            embed.setThumbnail(collectionInfo.image);
          }
          
          if (collectionInfo?.description) {
            embed.addFields({ name: 'Description', value: collectionInfo.description.substring(0, 1024), inline: false });
          }
          
          // Add examples of how to untrack this collection
          embed.addFields({ 
            name: 'How to Untrack', 
            value: `To remove this collection later, click **Untrack** in the collection list or use command: \`/untrack collection:${address}\``, 
            inline: false 
          });
          
          await interaction.editReply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          console.error('Error in track command:', error);
          await interaction.editReply({ 
            content: `Error fetching collection info, but the collection has been added. You can check the list with /list.`,
            ephemeral: true 
          });
        }
        break;
        
      case 'untrack':
        const untrackInput = options.getString('collection');
        if (!untrackInput) {
          // Defer reply since generating the collection list might take time
          await interaction.deferReply({ ephemeral: true });
          
          try {
            // If no address provided, show a list of tracked collections with untrack instructions
            const { embed, currentPage, totalPages } = createCollectionListEmbed(
              serverConfig.trackedCollections, 
              interaction.guild.name, 
              1, // start at page 1
              5 // items per page
            );
            
            // Add instructions on how to untrack
            const instructionEmbed = new EmbedBuilder()
              .setColor('#ff9900')
              .setTitle('How to Untrack Collections')
              .setDescription('To untrack a collection, use one of the following methods:')
              .addFields(
                { name: '1. Use the Untrack Buttons', value: 'Click the untrack button below any collection in the list.' },
                { name: '2. Use Collection Number', value: 'Use `/untrack collection:1` to untrack collection #1' },
                { name: '3. Use Collection Address', value: 'Use `/untrack collection:0x1234...` with the collection address' }
              );
            
            await interaction.editReply({ embeds: [instructionEmbed, embed], ephemeral: true });
          } catch (error) {
            console.error('Error in untrack command (list):', error);
            await interaction.editReply({ 
              content: `Error generating collection list. Please try again or provide a collection address to untrack.`,
              ephemeral: true 
            });
          }
          return;
        }
        
        // Handle numeric input (collection number)
        if (/^\d+$/.test(untrackInput.trim())) {
          // Convert to number and adjust for 1-based indexing
          const collectionNumber = parseInt(untrackInput.trim());
          const collectionEntries = Object.entries(serverConfig.trackedCollections);
          
          // Check if the number is valid
          if (collectionNumber <= 0 || collectionNumber > collectionEntries.length) {
            await interaction.reply({ 
              content: `Invalid collection number. Please use a number between 1 and ${collectionEntries.length}.`, 
              ephemeral: true 
            });
            return;
          }
          
          // Get the collection at that index (adjust for 0-based array)
          const [addressToRemove, collectionData] = collectionEntries[collectionNumber - 1];
          const collectionName = collectionData.name || addressToRemove;
          
          // Remove the collection
          delete serverConfig.trackedCollections[addressToRemove];
          saveServerConfigs();
          
          await interaction.reply({ 
            content: `No longer tracking collection #${collectionNumber}: ${collectionName}`, 
            ephemeral: true 
          });
          return;
        }
        
        // Direct address from autocomplete or explicitly entered
        if (serverConfig.trackedCollections[untrackInput]) {
          const collectionName = serverConfig.trackedCollections[untrackInput].name || untrackInput;
          delete serverConfig.trackedCollections[untrackInput];
          saveServerConfigs();
          await interaction.reply({ 
            content: `No longer tracking collection: ${collectionName}`, 
            ephemeral: true 
          });
          return;
        }
        
        // Check if the input matches any collection name (case insensitive partial match)
        const collectionEntries = Object.entries(serverConfig.trackedCollections);
        const matchByName = collectionEntries.find(([_, data]) => 
          data.name && data.name.toLowerCase().includes(untrackInput.toLowerCase())
        );
        
        if (matchByName) {
          const [addressToRemove, collectionData] = matchByName;
          const collectionName = collectionData.name;
          
          // Remove the collection
          delete serverConfig.trackedCollections[addressToRemove];
          saveServerConfigs();
          
          await interaction.reply({ 
            content: `No longer tracking collection: ${collectionName}`, 
            ephemeral: true 
          });
          return;
        }
        
        // Extract collection address if it's a URL
        const untrackData = extractCollectionAddress(untrackInput);
        const untrackAddress = untrackData ? untrackData.address : untrackInput;
        
        if (serverConfig.trackedCollections[untrackAddress]) {
          const collectionName = serverConfig.trackedCollections[untrackAddress].name || untrackAddress;
          delete serverConfig.trackedCollections[untrackAddress];
          saveServerConfigs();
          await interaction.reply({ content: `No longer tracking collection: ${collectionName}`, ephemeral: true });
        } else {
          // Defer reply since generating the collection list might take time
          await interaction.deferReply({ ephemeral: true });
          
          try {
            // If the collection isn't found, show a list of tracked collections
            const { embed, currentPage, totalPages } = createCollectionListEmbed(
              serverConfig.trackedCollections, 
              interaction.guild.name, 
              1, // start at page 1
              5 // items per page
            );
            
            await interaction.editReply({ 
              content: `Could not find a collection matching "${untrackInput}". Here are your tracked collections:`,
              embeds: [embed], 
              ephemeral: true 
            });
          } catch (error) {
            console.error('Error in untrack command (not found):', error);
            await interaction.editReply({ 
              content: `Could not find a collection matching "${untrackInput}". Use /list to see your tracked collections.`,
              ephemeral: true 
            });
          }
        }
        break;
        
      case 'list':
        // Defer reply since updating collection info might take time
        await interaction.deferReply({ ephemeral: true });
        
        try {
          // First try to update collection info for any unknown collections
          await updateCollectionInfo(guildId);
          
          // Create paginated list starting at page 1
          const { embed, currentPage, totalPages } = createCollectionListEmbed(
            serverConfig.trackedCollections, 
            interaction.guild.name, 
            1, // start at page 1
            5 // items per page
          );
          
          // Create navigation and action buttons
          const components = createCollectionListComponents(currentPage, totalPages, serverConfig.trackedCollections);
          
          await interaction.editReply({ 
            embeds: [embed], 
            components,
            ephemeral: true 
          });
        } catch (error) {
          console.error('Error in list command:', error);
          await interaction.editReply({
            content: 'Error generating tracked collections list. Please try again later.',
            ephemeral: true
          });
        }
        break;
        
      case 'help':
        const helpEmbed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle('NFT Sales Bot Commands')
          .setDescription('Here are the commands you can use:')
          .addFields(
            { name: '/setchannel', value: 'Set the current channel for sales notifications (Admin only)' },
            { name: '/track <collection>', value: 'Start tracking sales for a specific collection (accepts Magic Eden URLs or addresses)' },
            { name: '/untrack <collection>', value: 'Stop tracking a collection. Use collection address or a collection number (e.g., `/untrack 1`)' },
            { name: '/list', value: 'Show all currently tracked collections with pagination and untrack buttons' },
            { name: '/help', value: 'Show this help message' }
          );
        
        await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        break;
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    
    // Try to respond if we haven't already
    try {
      if (interaction.deferred) {
        await interaction.editReply({ 
          content: 'An error occurred while processing your command. Please try again.',
          ephemeral: true 
        });
      } else if (!interaction.replied) {
        await interaction.reply({ 
          content: 'An error occurred while processing your command. Please try again.',
          ephemeral: true 
        });
      }
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
});

// Discord bot legacy commands for backward compatibility
client.on('messageCreate', async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Ignore DMs
  if (!message.guild) return;
  
  // Only process command messages
  if (!message.content.startsWith('!')) return;
  
  // Get or initialize server configuration
  const guildId = message.guild.id;
  const serverConfig = initServerConfig(guildId);
  
  // Legacy command handler - will encourage users to switch to slash commands
  if (message.content.startsWith('!setchannel')) {
    await message.reply('⚠️ Legacy commands are being phased out. Please use slash commands instead: `/setchannel`');
    
    // Only admins can set the notification channel
    if (!isAdmin(message.member)) {
      await message.reply('You need administrator permissions to use this command.');
      return;
    }
    
    serverConfig.notificationChannelId = message.channel.id;
    saveServerConfigs();
    await message.reply(`Set this channel as the notification channel for NFT sales!`);
  }
  
  else if (message.content.startsWith('!track')) {
    await message.reply('⚠️ Legacy commands are being phased out. Please use slash commands instead: `/track`');
    
    // Check if notification channel is set
    if (!serverConfig.notificationChannelId) {
      await message.reply('Please set a notification channel first using !setchannel');
      return;
    }
    
    const collectionInput = message.content.split(' ').slice(1).join(' ');
    if (!collectionInput) {
      await message.reply('Please provide a collection address to track.');
      return;
    }
    
    // Extract collection address from input
    const collectionData = extractCollectionAddress(collectionInput);
    if (!collectionData) {
      await message.reply('Invalid collection address or URL format. Please provide a valid Ethereum address (starting with 0x) or Magic Eden collection URL.');
      return;
    }
    
    const { address, source, url } = collectionData;
    
    if (serverConfig.trackedCollections[address]) {
      await message.reply(`Already tracking collection: ${address}`);
      return;
    }
    
    // Try to fetch collection info from Magic Eden
    const collectionInfo = await fetchCollectionInfo(address);
    
    // Add to tracked collections
    serverConfig.trackedCollections[address] = {
      address,
      source,
      url,
      name: collectionInfo?.name || 'Unknown Collection',
      image: collectionInfo?.image || null,
      description: collectionInfo?.description || null,
      floorPrice: collectionInfo?.floorPrice || null,
      addedAt: new Date().toISOString(),
      addedBy: message.author.id
    };
    
    saveServerConfigs();
    
    // Create embed for response
    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle(`Now Tracking: ${collectionInfo?.name || address}`)
      .setDescription(`Successfully added to tracking list.`)
      .addFields(
        { name: 'Address', value: `\`${address}\``, inline: false },
        { name: 'Source', value: source, inline: true },
        { name: 'Added By', value: `<@${message.author.id}>`, inline: true }
      )
      .setTimestamp();
    
    if (collectionInfo?.image) {
      embed.setThumbnail(collectionInfo.image);
    }
    
    if (collectionInfo?.description) {
      embed.addFields({ name: 'Description', value: collectionInfo.description.substring(0, 1024), inline: false });
    }
    
    await message.reply({ embeds: [embed] });
  }
  
  else if (message.content.startsWith('!untrack')) {
    await message.reply('⚠️ Legacy commands are being phased out. Please use slash commands instead: `/untrack`');
    
    const addressToUntrack = message.content.split(' ').slice(1).join(' ');
    if (!addressToUntrack) {
      await message.reply('Please provide a collection address to untrack.');
      return;
    }
    
    // Extract collection address if it's a URL
    const untrackData = extractCollectionAddress(addressToUntrack);
    const untrackAddress = untrackData ? untrackData.address : addressToUntrack;
    
    if (serverConfig.trackedCollections[untrackAddress]) {
      const collectionName = serverConfig.trackedCollections[untrackAddress].name || untrackAddress;
      delete serverConfig.trackedCollections[untrackAddress];
      saveServerConfigs();
      await message.reply(`No longer tracking collection: ${collectionName}`);
    } else {
      await message.reply(`Not tracking collection: ${untrackAddress}`);
    }
  }
  
  else if (message.content === '!list') {
    await message.reply('⚠️ Legacy commands are being phased out. Please use slash commands instead: `/list`');
    
    const listEmbed = createCollectionListEmbed(serverConfig.trackedCollections, message.guild.name);
    await message.reply({ embeds: [listEmbed] });
  }
  
  else if (message.content === '!help') {
    await message.reply('⚠️ Legacy commands are being phased out. Please use slash commands instead: `/help`');
    
    const helpEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('NFT Sales Bot Commands')
      .setDescription('Here are the commands you can use:')
      .addFields(
        { name: '/setchannel', value: 'Set the current channel for sales notifications (Admin only)' },
        { name: '/track <collection>', value: 'Start tracking sales for a specific collection (accepts Magic Eden URLs or addresses)' },
        { name: '/untrack <collection>', value: 'Stop tracking a collection. Use collection address or a collection number (e.g., `/untrack 1`)' },
        { name: '/list', value: 'Show all currently tracked collections with pagination and untrack buttons' },
        { name: '/help', value: 'Show this help message' }
      );
    
    await message.reply({ embeds: [helpEmbed] });
  }
});

// Fix existing collections with full URLs in the addresses
function cleanServerConfigurations() {
  console.log('Checking and cleaning server configurations...');
  let changed = false;
  
  for (const [guildId, serverConfig] of Object.entries(serverConfigs)) {
    if (!serverConfig.trackedCollections) continue;
    
    const collections = serverConfig.trackedCollections;
    const newCollections = {};
    
    for (const [address, metadata] of Object.entries(collections)) {
      // Check if this is a full URL and extract the address
      if (address.includes('magiceden.io')) {
        const extracted = extractCollectionAddress(address);
        if (extracted) {
          console.log(`Fixing collection address in guild ${guildId}: ${address} -> ${extracted.address}`);
          
          // Copy the metadata to the new address and skip the old one
          newCollections[extracted.address] = {
            ...metadata,
            address: extracted.address,
            url: address // Keep the original URL if available
          };
          changed = true;
        } else {
          newCollections[address] = metadata;
        }
      } else {
        newCollections[address] = metadata;
      }
    }
    
    // Replace the collections with the cleaned version
    serverConfig.trackedCollections = newCollections;
  }
  
  if (changed) {
    console.log('Fixed collection addresses in server configurations. Saving changes...');
    saveServerConfigs();
  } else {
    console.log('No collection addresses needed fixing.');
  }
}

// Bot ready event
client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  
  // Register slash commands
  await registerSlashCommands();
  
  // Load server configurations
  loadServerConfigs();
  
  // Clean up any URLs in collection addresses
  cleanServerConfigurations();
  
  // Clear the processed sales cache on startup
  console.log("Clearing sales cache to ensure new notifications are processed");
  lastProcessedSales.magicEden.clear();
  console.log("Sales cache cleared");
  
  // Check for Magic Eden API key
  const apiKey = process.env.MAGIC_EDEN_API_KEY || '';
  const hasApiKey = apiKey && apiKey !== 'YOUR_API_KEY';
  
  if (!hasApiKey) {
    console.log("\n⚠️ WARNING: No Magic Eden API key found! ⚠️");
    console.log("Magic Eden may restrict access to their API without an API key.");
    console.log("To add an API key, create or update your .env file with:");
    console.log("MAGIC_EDEN_API_KEY=your_api_key_here");
    console.log("You may need to register for an API key at https://docs.magiceden.io/\n");
  } else {
    console.log("\n✅ Magic Eden API key found in environment variables.\n");
  }
  
  // Log collections being tracked
  console.log("=== TRACKED COLLECTIONS ===");
  for (const [guildId, serverConfig] of Object.entries(serverConfigs)) {
    const guild = client.guilds.cache.get(guildId);
    const guildName = guild ? guild.name : 'Unknown Guild';
    const collections = serverConfig.trackedCollections || {};
    const collectionCount = Object.keys(collections).length;
    
    console.log(`Guild: ${guildName} (${guildId}) - ${collectionCount} collections`);
    
    for (const [address, metadata] of Object.entries(collections)) {
      console.log(`- ${metadata.name || 'Unknown'}: ${address}`);
    }
  }
  console.log("===========================");
  
  // Log the API endpoints we're using
  const chain = "monad-testnet";
  console.log("\n===== MAGIC EDEN API CONFIGURATION =====");
  console.log(`Chain: ${chain}`);
  console.log(`Collections endpoint: https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7`);
  console.log(`Activities endpoints that will be tried:`);
  console.log(`1. https://api-mainnet.magiceden.dev/v3/rtp/${chain}/activities`);
  console.log(`2. https://api-mainnet.magiceden.dev/v3/${chain}/activities`);
  console.log(`3. https://api-mainnet.magiceden.dev/v2/${chain}/activities`);
  console.log("=========================================\n");
  
  // Schedule regular polling using node-cron
  // Check every minute by default
  const minutes = Math.floor(config.refreshInterval / 60000);
  const cronExpression = `*/${Math.max(1, minutes)} * * * *`;
  
  // Run immediately and then on schedule
  console.log('🔍 RUNNING INITIAL SALES CHECK...');
  try {
    await processSales();
    console.log('✅ Initial sales check complete!');
  } catch (error) {
    console.error('❌ Error during initial sales check:', error.message);
  }
  
  cron.schedule(cronExpression, () => {
    console.log('Checking for new sales...');
    processSales();
  });
  
  console.log(`Sale tracking scheduled (${cronExpression})`);
});

// Start the bot
client.login(config.discordToken).catch(error => {
  console.error('Failed to login to Discord:', error);
});

// Function to create page navigation and action buttons for collection list
function createCollectionListComponents(currentPage, totalPages, collections) {
  const components = [];
  
  // Create navigation row if needed
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder();
    
    // Previous page button
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`page_${currentPage}_prev`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⬅️')
        .setDisabled(currentPage <= 1)
    );
    
    // Page indicator (not a functional button, just visual)
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`page_${currentPage}_indicator`)
        .setLabel(`Page ${currentPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    
    // Next page button
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`page_${currentPage}_next`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('➡️')
        .setDisabled(currentPage >= totalPages)
    );
    
    components.push(navRow);
  }
  
  // Calculate current page items
  const collectionEntries = Object.entries(collections);
  const startIndex = (currentPage - 1) * 5; // 5 items per page
  const endIndex = Math.min(startIndex + 5, collectionEntries.length);
  const pageItems = collectionEntries.slice(startIndex, endIndex);
  
  // Create action row(s) for collection actions (untrack buttons)
  if (pageItems.length > 0) {
    // One button per collection, max 5 per row
    const actionRow = new ActionRowBuilder();
    
    for (let i = 0; i < pageItems.length; i++) {
      const [address, metadata] = pageItems[i];
      const collectionIndex = startIndex + i + 1; // Convert to 1-based index
      const name = metadata.name || '';
      
      // Determine if it's a generated address-based name or a real collection name
      const isAddressBasedName = name.includes(address.substring(0, 6)) || 
                                name.includes('Collection 0x') || 
                                name.includes('Monad Collection');
      
      // Create appropriate button label based on name
      let buttonLabel;
      if (isAddressBasedName || !name) {
        buttonLabel = `Collection ${collectionIndex}`;
      } else {
        // It has a real name, so use that (limit length)
        buttonLabel = name.substring(0, 20);
      }
      
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`untrack_${address}_${currentPage}`)
          .setLabel(buttonLabel)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️')
      );
    }
    
    components.push(actionRow);
  }
  
  return components;
}

// Add a force register command to update slash commands
async function forceRegisterCommands() {
  try {
    console.log('Force refreshing application (/) commands...');
    
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    
    // First, delete all existing commands
    await rest.put(
      Routes.applicationCommands(config.discordAppId),
      { body: [] }
    );
    
    console.log('Successfully deleted all application commands.');
    
    // Then register the commands again
    await rest.put(
      Routes.applicationCommands(config.discordAppId),
      { body: commands }
    );
    
    console.log('Successfully re-registered application commands.');
    return true;
  } catch (error) {
    console.error('Error force registering commands:', error);
    return false;
  }
}

// Add a message handler for the force-register command
client.on('messageCreate', async (message) => {
  // If the message is from the bot owner and is the special command
  if (message.content === '!force-register' && message.author.id === process.env.BOT_OWNER_ID) {
    const reply = await message.reply('Refreshing slash commands...');
    
    const success = await forceRegisterCommands();
    
    if (success) {
      await reply.edit('✅ Successfully refreshed slash commands! You may need to restart your Discord client.');
    } else {
      await reply.edit('❌ Failed to refresh commands. Check the logs for details.');
    }
  }
});

// Also, let's add a function to help debug current sales in cache
function debugCacheStatus() {
  console.log("=== SALES CACHE STATUS ===");
  console.log(`Cache size: ${lastProcessedSales.magicEden.size}/${MAX_CACHE_SIZE}`);
  console.log("Recent sale IDs in cache:");
  
  // Convert to array and get the 5 most recently added elements
  const entries = Array.from(lastProcessedSales.magicEden.entries());
  const recentEntries = entries.slice(-5);
  
  recentEntries.forEach(([id, timestamp], index) => {
    const time = new Date(timestamp).toISOString();
    console.log(`${index + 1}: ${id} (added: ${time})`);
  });
  console.log("=========================");
} 