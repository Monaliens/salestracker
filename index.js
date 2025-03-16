require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationCommandOptionType,
  REST,
  Routes
} = require('discord.js');
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
  magicEden: new Map() // saleId => timestamp
};

// Max number of sale IDs to remember (to prevent memory leaks)
const MAX_CACHE_SIZE = 20;

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
      trackedCollections: {}
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
    console.log(`Extracted collection address from Magic Eden URL: ${meMatch[1]}`);
    return {
      address: meMatch[1],
      source: 'Magic Eden',
      url: cleanedInput
    };
  }
  
  // If it looks like a contract address (0x format)
  if (cleanedInput.startsWith('0x')) {
    console.log(`Detected contract address format: ${cleanedInput}`);
    return {
      address: cleanedInput,
      source: 'Contract Address'
    };
  }
  
  // If it doesn't match known patterns but isn't empty, assume it's a direct collection ID
  if (cleanedInput.length > 0) {
    console.log(`Using direct collection ID: ${cleanedInput}`);
    return {
      address: cleanedInput,
      source: 'Direct Collection ID'
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
  
  // Define the chain parameter
  const chain = "monad-testnet";
  
  // Try Magic Eden API v7
  while (attempts < MAX_RETRIES) {
    try {
      console.log(`Fetching collection info for ${collectionAddress} (attempt ${attempts + 1}/${MAX_RETRIES})`);
      
      // Setup request options
      const options = {
        timeout: 10000, // 10 second timeout
        headers: {
          'accept': '*/*'
        }
      };
      
      // Using the correct endpoint with chain parameter and filtering by id
      // GET https://api-mainnet.magiceden.dev/v3/rtp/monad-testnet/collections/v7?id=CONTRACT_ADDRESS
      const v7Url = `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7?id=${collectionAddress}`;
      console.log(`Trying Magic Eden collections API: ${v7Url}`);
      
      const v7Response = await axios.get(v7Url, options);
      
      if (v7Response.data && v7Response.data.collections && v7Response.data.collections.length > 0) {
        // Get the first matching collection
        const collectionData = v7Response.data.collections[0];
        
        console.log(`Found collection in API: ${collectionData.name}`);
        console.log(`Collection data: ${JSON.stringify(collectionData, null, 2).substring(0, 500)}...`);
        
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
        console.log(`Collection ${collectionAddress} not found in collections API`);
      }
      
      // If we didn't find any collection, return a basic info object
      return {
        name: `Monad Collection ${collectionAddress.substring(0, 6)}...`,
        address: collectionAddress
      };
    } catch (error) {
      lastError = error;
      console.error(`Error fetching collection info (attempt ${attempts + 1}):`, error.message);
      
      if (error.response) {
        console.error('API response status:', error.response.status);
        console.error('API response data:', error.response.data);
      }
      
      attempts++;
      
      // Wait before retrying (exponential backoff)
      if (attempts < MAX_RETRIES) {
        const delay = 2000 * Math.pow(2, attempts - 1);
        console.log(`Retrying API in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  console.error(`Failed to fetch collection info after ${MAX_RETRIES} attempts`);
  
  // Return a fallback object with the address
  return {
    name: `Monad Collection ${collectionAddress.substring(0, 6)}...`,
    address: collectionAddress
  };
}

/**
 *  NEW FUNCTION: Fetch recent sales (activities) from Magic Eden
 *  This is how you actually retrieve the list of individual sales events.
 *
 *  - "collectionSymbol" might be the same as your extracted "address"
 *    but confirm with Magic Eden's docs or your actual collection name.
 *  - "type" param can be "buyNow, acceptOffer" or "sell" depending on the docs.
 */
async function fetchMagicEdenActivities(collectionAddress) {
  const chain = "monad-testnet";
  const limit = 20; // how many recent activities you want
  // Example endpoint (v3). Check Magic Eden docs if it needs adjustments:
  const url = `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/activities?collectionSymbol=${collectionAddress}&type=sell&limit=${limit}`;
  
  try {
    console.log(`Fetching activities for ${collectionAddress}...`);
    const response = await axios.get(url, { timeout: 10000 });
    if (response.data && response.data.activities) {
      return response.data.activities;
    }
    return [];
  } catch (error) {
    console.error(`Error fetching activities for ${collectionAddress}:`, error.message);
    return [];
  }
}

// Function to create a Discord embed for a sale notification
function createSaleEmbed(sale) {
  const collectionName = sale.collection?.name
    || sale.collection?.id
    || sale.collection
    || sale.collectionAddress
    || 'Unknown Collection';
    
  const tokenId = sale.tokenMint
    || sale.token?.tokenMint
    || sale.tokenId
    || 'Unknown Token';

  const price = sale.price
    || sale.amount
    || sale.value
    || 'Unknown';
  
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`New Sale: ${collectionName}`)
    .setTimestamp()
    .setFooter({ text: 'Source: Magic Eden' });
  
  if (tokenId) {
    embed.addFields({ name: 'Token ID', value: `${tokenId}`, inline: true });
  }
  if (price) {
    embed.addFields({ name: 'Price', value: `${price} MONAD`, inline: true });
  }

  const seller = sale.seller || sale.wallets?.seller || sale.sale?.sellerAddress;
  if (seller) {
    embed.addFields({ name: 'Seller', value: shortenAddress(seller), inline: true });
  }

  const buyer = sale.buyer || sale.wallets?.buyer || sale.sale?.buyerAddress;
  if (buyer) {
    embed.addFields({ name: 'Buyer', value: shortenAddress(buyer), inline: true });
  }

  if (sale.marketplace) {
    embed.addFields({ name: 'Marketplace', value: sale.marketplace, inline: true });
  }

  // transaction hash
  const txHash = sale.txHash || sale.signature || sale.transaction_hash || sale.txId;
  if (txHash) {
    embed.addFields({
      name: 'Transaction',
      value: `[View](https://explorer.monad.network/tx/${txHash})`,
      inline: true
    });
  }

  // Add NFT image if available
  const image = sale.token?.image || sale.image || sale.nft?.image || sale.metadata?.image;
  if (image) {
    embed.setImage(image);
  }

  return embed;
}

// Helper function to shorten addresses
function shortenAddress(address) {
  if (!address) return 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

/**
 *  MAIN function that processes new sales for every guild's tracked collections.
 *  Replaces the old "monitorCollectionStats" approach with direct "activities" calls.
 */
async function processSales() {
  try {
    console.log("=================== PROCESSING SALES (activities) ===================");

    // Clean up old cache entries (older than 1 hour) so we don't bloat memory
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [saleId, timestamp] of lastProcessedSales.magicEden.entries()) {
      if (now - timestamp > ONE_HOUR) {
        lastProcessedSales.magicEden.delete(saleId);
        console.log(`Removed old sale ID from cache: ${saleId}`);
      }
    }

    let salesFound = 0;

    // For each guild, fetch sales for each tracked collection
    for (const [guildId, serverConfig] of Object.entries(serverConfigs)) {
      if (!serverConfig.trackedCollections ||
          Object.keys(serverConfig.trackedCollections).length === 0 ||
          !serverConfig.notificationChannelId) {
        // no tracked collections or no channel
        continue;
      }

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

      console.log(`\nProcessing sales for guild: ${guild.name}`);
      const trackedAddrs = Object.keys(serverConfig.trackedCollections);

      for (const address of trackedAddrs) {
        // 1) Fetch up to N recent sales from Magic Eden
        const recentSales = await fetchMagicEdenActivities(address);

        if (!recentSales || recentSales.length === 0) {
          // no recent sales from the API
          continue;
        }

        // 2) Sort sales by time (ascending)
        recentSales.sort((a, b) => {
          const timeA = a.blockTime || a.createdAt || 0;
          const timeB = b.blockTime || b.createdAt || 0;
          return timeA - timeB;
        });

        // 3) For each sale, check if we've already processed it
        for (const sale of recentSales) {
          const saleId = sale.id || `${address}_${sale.txHash || Date.now()}`;
          const saleTime = sale.blockTime ? new Date(sale.blockTime * 1000) : new Date();

          if (!lastProcessedSales.magicEden.has(saleId)) {
            // 4) Mark it processed
            lastProcessedSales.magicEden.set(saleId, Date.now());
            // trim if needed
            if (lastProcessedSales.magicEden.size > MAX_CACHE_SIZE) {
              const oldestKey = Array.from(lastProcessedSales.magicEden.keys())[0];
              lastProcessedSales.magicEden.delete(oldestKey);
            }

            // 5) Create embed + send message
            const embed = createSaleEmbed(sale);
            console.log(`Sending sale notification for sale ID: ${saleId}`);
            await channel.send({ embeds: [embed] });
            salesFound++;
          }
        }
      }
    }

    if (salesFound === 0) {
      console.log("No new sales found across all guilds.");
    } else {
      console.log(`🔔 TOTAL NEW SALES NOTIFIED: ${salesFound}`);
    }
    console.log("=================== PROCESSING COMPLETE ===================\n");
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
            address: collectionAddress,
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

// Basic Ethereum address validation
function validateCollectionAddress(address) {
  const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  return ethAddressRegex.test(address);
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;
  
  try {
    // Handle button interactions
    if (interaction.isButton()) {
      // parse button ID
      const [action, ...params] = interaction.customId.split('_');
      
      // pagination
      if (action === 'page') {
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return;
        }
        
        const serverConfig = initServerConfig(guildId);
        const currentPage = parseInt(params[0]) || 1;
        const newPage = params[1] === 'next' ? currentPage + 1 : currentPage - 1;
        
        const { embed, currentPage: validatedPage, totalPages } = createCollectionListEmbed(
          serverConfig.trackedCollections, 
          interaction.guild.name, 
          newPage,
          5
        );
        
        const components = createCollectionListComponents(validatedPage, totalPages, serverConfig.trackedCollections);
        await interaction.update({ embeds: [embed], components });
        return;
      }
      
      // untrack button
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
          
          const { embed, currentPage: validatedPage, totalPages } = createCollectionListEmbed(
            serverConfig.trackedCollections,
            interaction.guild.name,
            page,
            5
          );
          
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
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const guildId = interaction.guildId;
    const serverConfig = initServerConfig(guildId);

    const { commandName, options } = interaction;

    switch (commandName) {
      case 'setchannel':
        if (!isAdmin(interaction.member)) {
          await interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: true });
          return;
        }
        serverConfig.notificationChannelId = interaction.channelId;
        saveServerConfigs();
        await interaction.reply({ content: `Set this channel as the notification channel for NFT sales!`, ephemeral: true });
        break;
        
      case 'track': {
        if (!serverConfig.notificationChannelId) {
          await interaction.reply({ content: 'Please set a notification channel first using /setchannel', ephemeral: true });
          return;
        }
        const collectionInput = options.getString('collection');
        if (!collectionInput) {
          await interaction.reply({ content: 'Please provide a collection address or Magic Eden URL.', ephemeral: true });
          return;
        }
        const collectionData = extractCollectionAddress(collectionInput);
        if (!collectionData) {
          await interaction.reply({
            content: 'Invalid collection address/URL. Must be a 0x address or a Magic Eden "monad-testnet" URL.',
            ephemeral: true
          });
          return;
        }
        const { address, source, url } = collectionData;
        if (!validateCollectionAddress(address)) {
          await interaction.reply({
            content: `The address \`${address}\` doesn't appear valid. Check for typos.`,
            ephemeral: true
          });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        if (serverConfig.trackedCollections[address]) {
          await interaction.editReply({ content: `Already tracking collection: ${address}`, ephemeral: true });
          return;
        }
        try {
          const collectionInfo = await fetchCollectionInfo(address);
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
          
          if (collectionInfo?.image) embed.setThumbnail(collectionInfo.image);
          if (collectionInfo?.description) {
            embed.addFields({ name: 'Description', value: collectionInfo.description.substring(0, 1024), inline: false });
          }
          embed.addFields({
            name: 'How to Untrack',
            value: `Use \`/untrack collection:${address}\` or click untrack in the \`/list\`.`
          });
          
          await interaction.editReply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          console.error('Error in track command:', error);
          await interaction.editReply({
            content: `Error fetching collection info. The collection has been added, but info is missing.`,
            ephemeral: true
          });
        }
        break;
      }
        
      case 'untrack': {
        const untrackInput = options.getString('collection');
        if (!untrackInput) {
          await interaction.deferReply({ ephemeral: true });
          try {
            const { embed } = createCollectionListEmbed(
              serverConfig.trackedCollections,
              interaction.guild.name,
              1,
              5
            );
            await interaction.editReply({
              content: 'No collection given. Here are your tracked collections:',
              embeds: [embed],
              ephemeral: true
            });
          } catch (error) {
            console.error('Error in untrack command (no address):', error);
            await interaction.editReply({
              content: 'Error retrieving your tracked collections. Try again later.',
              ephemeral: true
            });
          }
          return;
        }
        // If user gave a number
        if (/^\d+$/.test(untrackInput.trim())) {
          const collectionNumber = parseInt(untrackInput.trim());
          const collectionEntries = Object.entries(serverConfig.trackedCollections);
          if (collectionNumber <= 0 || collectionNumber > collectionEntries.length) {
            await interaction.reply({
              content: `Invalid number. Must be between 1 and ${collectionEntries.length}.`,
              ephemeral: true
            });
            return;
          }
          const [addressToRemove, data] = collectionEntries[collectionNumber - 1];
          const cName = data.name || addressToRemove;
          delete serverConfig.trackedCollections[addressToRemove];
          saveServerConfigs();
          await interaction.reply({
            content: `No longer tracking collection #${collectionNumber}: ${cName}`,
            ephemeral: true
          });
          return;
        }
        
        // If user gave an address or partial name
        if (serverConfig.trackedCollections[untrackInput]) {
          const cName = serverConfig.trackedCollections[untrackInput].name || untrackInput;
          delete serverConfig.trackedCollections[untrackInput];
          saveServerConfigs();
          await interaction.reply({ content: `No longer tracking: ${cName}`, ephemeral: true });
          return;
        }
        const collectionEntries = Object.entries(serverConfig.trackedCollections);
        const matchByName = collectionEntries.find(([_, data]) => {
          return data.name && data.name.toLowerCase().includes(untrackInput.toLowerCase());
        });
        if (matchByName) {
          const [addr, data] = matchByName;
          delete serverConfig.trackedCollections[addr];
          saveServerConfigs();
          await interaction.reply({ content: `No longer tracking: ${data.name}`, ephemeral: true });
          return;
        }
        
        const untrackData = extractCollectionAddress(untrackInput);
        const untrackAddress = untrackData ? untrackData.address : untrackInput;
        if (serverConfig.trackedCollections[untrackAddress]) {
          const cName = serverConfig.trackedCollections[untrackAddress].name || untrackAddress;
          delete serverConfig.trackedCollections[untrackAddress];
          saveServerConfigs();
          await interaction.reply({ content: `No longer tracking collection: ${cName}`, ephemeral: true });
        } else {
          await interaction.deferReply({ ephemeral: true });
          try {
            const { embed } = createCollectionListEmbed(
              serverConfig.trackedCollections,
              interaction.guild.name,
              1,
              5
            );
            await interaction.editReply({
              content: `Could not find a collection matching "${untrackInput}". Here are your tracked collections:`,
              embeds: [embed],
              ephemeral: true
            });
          } catch (error) {
            console.error('Error in untrack command (not found):', error);
            await interaction.editReply({
              content: `Could not find a matching collection. Use /list to see them.`,
              ephemeral: true
            });
          }
        }
        break;
      }
        
      case 'list': {
        await interaction.deferReply({ ephemeral: true });
        try {
          await updateCollectionInfo(guildId);
          const { embed, currentPage, totalPages } = createCollectionListEmbed(
            serverConfig.trackedCollections,
            interaction.guild.name,
            1,
            5
          );
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
      }

      case 'help':
        const helpEmbed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle('NFT Sales Bot Commands')
          .setDescription('Here are the commands you can use:')
          .addFields(
            { name: '/setchannel', value: 'Set the current channel for sales notifications (Admin only)' },
            { name: '/track <collection>', value: 'Track sales for a specific collection (Magic Eden URL or 0x address)' },
            { name: '/untrack <collection>', value: 'Stop tracking a collection. You can supply the address or the list index' },
            { name: '/list', value: 'Show all currently tracked collections (with pagination)' },
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

// Basic function to create a paginated embed for tracked collections
function createCollectionListEmbed(collections, guildName, page = 1, itemsPerPage = 5) {
  const collectionEntries = Object.entries(collections);
  const totalCollections = collectionEntries.length;
  const totalPages = Math.ceil(totalCollections / itemsPerPage);
  
  page = Math.max(1, Math.min(page, totalPages || 1));
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalCollections);
  const pageItems = collectionEntries.slice(startIndex, endIndex);

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`Tracked Collections in ${guildName}`)
    .setDescription(
      totalCollections === 0
        ? 'No collections being tracked.'
        : `Currently tracking ${totalCollections} collections`
    )
    .setTimestamp();
  
  if (totalPages > 1) {
    embed.setFooter({ text: `Page ${page}/${totalPages}` });
  } else {
    embed.setFooter({ text: `${totalCollections} collections` });
  }

  pageItems.forEach(([addr, data], i) => {
    const index = startIndex + i + 1;
    const displayName = data.name || addr;
    const meUrl = `https://magiceden.io/collections/monad-testnet/${addr}`;
    const addedAt = data.addedAt ? new Date(data.addedAt).toLocaleDateString() : 'Unknown';
    embed.addFields({
      name: `${index}. ${displayName}`,
      value: `Address: \`${addr.substring(0, 8)}...\`\n[View on ME](${meUrl}) • Added: ${addedAt}`
    });
  });
  
  return { embed, currentPage: page, totalPages };
}

// Button row(s) for collection list pagination + untrack
function createCollectionListComponents(currentPage, totalPages, collections) {
  const components = [];
  // page nav
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder();
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`page_${currentPage}_prev`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⬅️')
        .setDisabled(currentPage <= 1)
    );
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`page_${currentPage}_indicator`)
        .setLabel(`Page ${currentPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
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

  // untrack row (one button per collection on current page)
  const collectionEntries = Object.entries(collections);
  const startIndex = (currentPage - 1) * 5;
  const endIndex = Math.min(startIndex + 5, collectionEntries.length);
  const pageItems = collectionEntries.slice(startIndex, endIndex);
  
  if (pageItems.length > 0) {
    const actionRow = new ActionRowBuilder();
    pageItems.forEach(([addr, data], i) => {
      const index = startIndex + i + 1;
      let displayLabel = data.name || `Collection ${index}`;
      if (displayLabel.length > 20) {
        displayLabel = displayLabel.substring(0, 20) + '…';
      }
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`untrack_${addr}_${currentPage}`)
          .setLabel(displayLabel)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️')
      );
    });
    components.push(actionRow);
  }
  return components;
}

// Clean up server configs if needed (removes old ME URLs as keys)
function cleanServerConfigurations() {
  console.log('Checking and cleaning server configurations...');
  let changed = false;
  for (const [guildId, serverConfig] of Object.entries(serverConfigs)) {
    if (!serverConfig.trackedCollections) continue;
    const collections = serverConfig.trackedCollections;
    const newCollections = {};
    for (const [address, metadata] of Object.entries(collections)) {
      if (address.includes('magiceden.io')) {
        const extracted = extractCollectionAddress(address);
        if (extracted) {
          console.log(`Fixing collection address in guild ${guildId}: ${address} -> ${extracted.address}`);
          newCollections[extracted.address] = {
            ...metadata,
            address: extracted.address,
            url: address
          };
          changed = true;
        } else {
          newCollections[address] = metadata;
        }
      } else {
        newCollections[address] = metadata;
      }
    }
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
  
  await registerSlashCommands();
  loadServerConfigs();
  cleanServerConfigurations();
  
  // Clear the processed sales cache on startup
  lastProcessedSales.magicEden.clear();
  console.log("Sales cache cleared on startup.");

  const apiKey = process.env.MAGIC_EDEN_API_KEY || '';
  if (!apiKey || apiKey === 'YOUR_API_KEY') {
    console.log("\n⚠️ WARNING: No Magic Eden API key found! You may be rate-limited.\n");
  } else {
    console.log("\n✅ Magic Eden API key found.\n");
  }

  // Print tracked collections
  console.log("=== TRACKED COLLECTIONS ===");
  for (const [guildId, cfg] of Object.entries(serverConfigs)) {
    const guild = client.guilds.cache.get(guildId);
    const gName = guild ? guild.name : 'Unknown Guild';
    const colls = cfg.trackedCollections || {};
    console.log(`Guild: ${gName} (${guildId}) - ${Object.keys(colls).length} collections`);
    for (const [addr, data] of Object.entries(colls)) {
      console.log(` - ${data.name || 'Unknown'}: ${addr}`);
    }
  }
  console.log("===========================");

  // Start cron job (poll every X minutes)
  const minutes = Math.floor(config.refreshInterval / 60000) || 1;
  const cronExpression = `*/${minutes} * * * *`; // every X minutes
  console.log(`Starting sale checking job with cron pattern: ${cronExpression}`);

  // Initial run
  try {
    await processSales();
    console.log('Initial sales check complete!');
  } catch (error) {
    console.error('Error during initial sales check:', error.message);
  }

  cron.schedule(cronExpression, () => {
    console.log('CRON: Checking for new sales...');
    processSales();
  });
});

// Start the bot
client.login(config.discordToken).catch(error => {
  console.error('Failed to login to Discord:', error);
});

// Optional: Force register slash commands via a message (for debugging)
async function forceRegisterCommands() {
  try {
    console.log('Force refreshing application (/) commands...');
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    // Clear existing
    await rest.put(Routes.applicationCommands(config.discordAppId), { body: [] });
    // Re-register
    await rest.put(Routes.applicationCommands(config.discordAppId), { body: commands });
    console.log('Successfully re-registered slash commands.');
    return true;
  } catch (error) {
    console.error('Error force registering commands:', error);
    return false;
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // Example "force-register" text command
  if (message.content === '!force-register' && message.author.id === process.env.BOT_OWNER_ID) {
    const reply = await message.reply('Refreshing slash commands...');
    const success = await forceRegisterCommands();
    if (success) {
      await reply.edit('✅ Successfully refreshed slash commands!');
    } else {
      await reply.edit('❌ Failed to refresh commands. Check logs for details.');
    }
  }
});

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
      
      // Fetch current collection info/stats using Magic Eden API
      const chain = "monad-testnet";
      // Use format: https://api-mainnet.magiceden.dev/v3/rtp/monad-testnet/collections/v7?id=CONTRACT_ADDRESS
      const url = `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7?id=${address}`;
      
      console.log(`Fetching collection stats from: ${url}`);
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
      
      console.log(`Current collection stats: ${JSON.stringify(currentStats)}`);
      
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
          
          // Calculate the price from volume change
          const priceEstimate = volumeIncreased ? 
            (currentStats.volume - previousStats.volume).toFixed(4) : 
            currentStats.floorPrice?.toFixed(4) || "Unknown";
          
          // Create a synthetic sale object with the available information
          const syntheticSale = {
            collection: {
              id: address,
              name: collectionData.name
            },
            price: priceEstimate,
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