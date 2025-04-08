const fs = require('fs');

const filePath = './index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace lastProcessedSales structure with new one
content = content.replace(
  "const lastProcessedSales = {\n  processedSales: new Map() // saleId => timestamp\n};",
  "const lastProcessedSales = {\n  // Collection address => Map of (saleId => timestamp)\n  collections: new Map()\n};"
);

// Replace MAX_CACHE_SIZE with new constant
content = content.replace(
  "// Max number of sale IDs to remember (to prevent memory leaks)\nconst MAX_CACHE_SIZE = 100;",
  "// Max number of sale IDs to remember per collection (to prevent memory leaks)\nconst MAX_CACHE_SIZE_PER_COLLECTION = 50;"
);

// Add new helper functions before validateWhitelist
content = content.replace(
  "// Validate whitelist configuration\nfunction validateWhitelist() {",
  `// Has sale been processed?
function hasSaleBeenProcessed(collectionAddr, saleId) {
  if (!lastProcessedSales.collections.has(collectionAddr)) {
    return false;
  }
  
  const salesMap = lastProcessedSales.collections.get(collectionAddr);
  return salesMap.has(saleId);
}

// Add sale to processed cache 
function addSaleToProcessed(collectionAddr, saleId) {
  // Create map for collection if it doesn't exist
  if (!lastProcessedSales.collections.has(collectionAddr)) {
    lastProcessedSales.collections.set(collectionAddr, new Map());
  }
  
  const salesMap = lastProcessedSales.collections.get(collectionAddr);
  
  // Add sale ID with current timestamp
  salesMap.set(saleId, Date.now());
  
  // Trim if needed
  if (salesMap.size > MAX_CACHE_SIZE_PER_COLLECTION) {
    // Get oldest entry (first item)
    const oldestKey = Array.from(salesMap.keys())[0];
    salesMap.delete(oldestKey);
  }
  
  return true;
}

// Validate whitelist configuration\nfunction validateWhitelist() {`
);

// Update the debugCacheStatus function
content = content.replace(
  "// Debug function to show cache status\nfunction debugCacheStatus() {\n  console.log(`Sales cache size: ${lastProcessedSales.processedSales.size} entries`);\n}",
  `// Debug function to show cache status
function debugCacheStatus() {
  let totalEntries = 0;
  let collectionCount = lastProcessedSales.collections.size;
  
  for (const salesMap of lastProcessedSales.collections.values()) {
    totalEntries += salesMap.size;
  }
  
  console.log(\`Sales cache status: \${totalEntries} total sales cached across \${collectionCount} collections\`);
  
  // Log details for each collection
  for (const [collectionAddr, salesMap] of lastProcessedSales.collections.entries()) {
    console.log(\`- Collection \${collectionAddr}: \${salesMap.size} sales cached\`);
  }
}`
);

// Update checkAndNotifySales function to use collection-specific cache
// First, add the collection address extraction
content = content.replace(
  "const saleId = sale.id || `reservoir_${Date.now()}`;\n      \n      const collectionName",
  "const saleId = sale.id || `reservoir_${Date.now()}`;\n      \n      // Get collection address\n      const collectionAddr = sale.collection.id;\n      \n      const collectionName"
);

// Update the check for previously processed sales
content = content.replace(
  "// Check if we've already notified about this sale\n      if (lastProcessedSales.processedSales.has(saleId)) {\n        console.log(`🔄 Already notified about sale ${saleId} (${collectionName}), skipping`);\n        continue;\n      }",
  `// Check if we've already notified about this sale
      if (hasSaleBeenProcessed(collectionAddr, saleId)) {
        console.log(\`🔄 Already processed sale \${saleId} (\${collectionName}), skipping\`);
        continue;
      }`
);

// Update how we add to the cache for successful notifications
content = content.replace(
  "// Mark as notified - use set with timestamp\n        lastProcessedSales.processedSales.set(saleId, Date.now());\n        console.log(`📋 Added sale ${saleId} to processed cache`);\n        successCount++;\n        \n        // Trim cache if needed\n        if (lastProcessedSales.processedSales.size > MAX_CACHE_SIZE) {\n          const oldestKey = Array.from(lastProcessedSales.processedSales.keys())[0];\n          lastProcessedSales.processedSales.delete(oldestKey);\n          console.log(`🧹 Trimmed oldest sale from cache: ${oldestKey}`);\n        }",
  `// Mark as notified in collection cache
        addSaleToProcessed(collectionAddr, saleId);
        console.log(\`📋 Added sale \${saleId} to collection cache for \${collectionAddr}\`);
        successCount++;`
);

// Update error case cache addition
content = content.replace(
  "// Still add to cache to avoid repeatedly trying to send failed notifications\n        lastProcessedSales.processedSales.set(saleId, Date.now());",
  `// Still add to cache to avoid repeatedly trying to send failed notifications
        addSaleToProcessed(collectionAddr, saleId);`
);

// Update initialization process
content = content.replace(
  "// Clear the processed sales cache to ensure we start fresh\n  lastProcessedSales.processedSales.clear();\n  console.log('🧹 Cleared sales cache for fresh start');",
  `// Clear the sales cache completely - don't load old cache
  lastProcessedSales.collections.clear();
  console.log('🧹 Cleared sales cache for fresh start');`
);

// Update initialization check
content = content.replace(
  `// Make the initial sales check run after a delay to give the bot time to connect
  setTimeout(() => {
    console.log('🔍 Running initial sales check for all servers...');
    for (const serverId in serverConfigs) {
      try {
        // Only check whitelisted servers
        if (isGuildWhitelisted(serverId)) {
          checkAndNotifySales(serverId);
        } else {
          console.log(\`⏩ Skipping initial check for non-whitelisted guild: \${serverId}\`);
        }
      } catch (error) {
        console.error(\`❌ Error in initial sales check for server \${serverId}:\`, error);
      }
    }`,
  `// Make the initial sales check run after a delay to give the bot time to connect
  // But do NOT send notifications for initial sales - only cache them
  setTimeout(async () => {
    console.log('🔍 Running initial sales check for all servers (NOTIFICATION DISABLED - ONLY CACHING)...');
    
    // First, gather all collection addresses across all servers
    const allCollectionAddresses = new Set();
    
    for (const serverId in serverConfigs) {
      // Only check whitelisted servers
      if (!isGuildWhitelisted(serverId)) {
        console.log(\`⏩ Skipping initial check for non-whitelisted guild: \${serverId}\`);
        continue;
      }
      
      try {
        const serverConfig = serverConfigs[serverId];
        if (!serverConfig || !serverConfig.trackedCollections) continue;
        
        // Extract collection addresses
        for (const key in serverConfig.trackedCollections) {
          const collection = serverConfig.trackedCollections[key];
          const address = typeof collection === 'string' ? collection : collection.address;
          if (address) allCollectionAddresses.add(address);
        }
      } catch (error) {
        console.error(\`❌ Error collecting addresses for server \${serverId}:\`, error);
      }
    }
    
    // Now fetch sales for all collections at once, but don't send notifications
    console.log(\`🔄 Caching existing sales for \${allCollectionAddresses.size} collections during initialization...\`);
    
    if (allCollectionAddresses.size === 0) {
      console.log('No collections to check, skipping initial cache');
      return;
    }
    
    try {
      // Use fetchReservoirSales directly
      const initialSales = await fetchReservoirSales([...allCollectionAddresses]);
      console.log(\`📦 Found \${initialSales.length} existing sales to cache\`);
      
      // Add all these sales to the cache without notifications
      let newCacheEntries = 0;
      for (const sale of initialSales) {
        const saleId = sale.id || \`reservoir_\${Date.now()}\`;
        const collectionAddr = sale.collection.id;
        
        // Always add to cache during initialization
        addSaleToProcessed(collectionAddr, saleId);
        newCacheEntries++;
      }
      
      console.log(\`✅ Added \${newCacheEntries} new entries to sales cache during initialization\`);
      console.log(\`✅ Initial sales caching complete - bot is now ready to monitor for NEW sales only\`);
      console.log(\`🚫 No notifications were sent for existing \${newCacheEntries} sales\`);
    } catch (error) {
      console.error('❌ Error during initial sales caching:', error);
    }`
);

// Add timestamp to footer rather than padded spaces
content = content.replace(
  "// Add footer with source and transaction hash (extreme left)\n  embed.setFooter({ \n    text: `👽 Made with Monalien Tech                                          ${new Date().toLocaleTimeString()}`,\n    iconURL: 'https://cdn.discordapp.com/attachments/925536605738471425/1198969003852148797/A-27.png'\n  });\n  \n  // Remove timestamp to avoid default right-side timestamp\n  // embed.setTimestamp();",
  `// Add footer with source and transaction hash
  embed.setFooter({ 
    text: \`👽 Made with Monalien Tech\`,
    iconURL: 'https://cdn.discordapp.com/attachments/925536605738471425/1198969003852148797/A-27.png'
  });
  
  // Add timestamp for standardized time display
  embed.setTimestamp();`
);

// Write the changes back to the file
fs.writeFileSync(filePath, content);
console.log('✅ Bot code fixed successfully!');
