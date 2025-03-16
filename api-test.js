const axios = require('axios');

// Test configuration
const chain = "monad-testnet";
const collectionExample = "0x66c40f67afd710386379a6bb24d00308f81c148a"; // Example collection ID

// Function to test an API endpoint
async function testEndpoint(url, params = {}) {
  console.log(`\n🔍 Testing endpoint: ${url}`);
  console.log(`Parameters: ${JSON.stringify(params)}`);
  
  try {
    const response = await axios.get(url, { 
      params,
      timeout: 10000,
      headers: { 'accept': '*/*' }
    });
    
    console.log(`✅ SUCCESS: Status ${response.status}`);
    console.log(`Response data keys: ${Object.keys(response.data)}`);
    
    // Print small sample of the response
    const sample = JSON.stringify(response.data).substring(0, 500);
    console.log(`Sample response: ${sample}...`);
    
    return response.data;
  } catch (error) {
    console.log(`❌ ERROR: ${error.message}`);
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Error data: ${JSON.stringify(error.response.data)}`);
    }
    return null;
  }
}

// Run all the tests
async function runTests() {
  console.log("===== TESTING MAGIC EDEN API FOR MONAD-TESTNET =====");
  
  // Test 1: Collections endpoint v7 (searching by id)
  const collectionsData = await testEndpoint(
    `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7`,
    { id: collectionExample }
  );
  
  // Test 2: Try getting all collections for Monad
  await testEndpoint(
    `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7`,
    { limit: 10 }
  );
  
  // If we found collections, get the first one for further testing
  let foundCollectionId = null;
  if (collectionsData && collectionsData.collections && collectionsData.collections.length > 0) {
    foundCollectionId = collectionsData.collections[0].id;
    console.log(`Found collection ID: ${foundCollectionId}`);
  } else {
    // Try to find any Monad collection
    const allCollections = await testEndpoint(
      `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/v7`,
      { limit: 10 }
    );
    
    if (allCollections?.collections?.length > 0) {
      foundCollectionId = allCollections.collections[0].id;
      console.log(`Found alternative collection ID: ${foundCollectionId}`);
    }
  }
  
  // New endpoint variations to test

  // Test: Try the collection-specific activities endpoint
  if (foundCollectionId) {
    await testEndpoint(
      `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/${foundCollectionId}/activities`,
      { limit: 20, offset: 0, types: 'Sale' }
    );
  }
  
  // Test: Try querying directly with the monad- prefix on various endpoints
  await testEndpoint(
    `https://api-mainnet.magiceden.dev/v3/monad/activities`,
    { limit: 20, offset: 0, types: 'Sale' }
  );
  
  await testEndpoint(
    `https://api-mainnet.magiceden.dev/v3/rtp/monad/activities`,
    { limit: 20, offset: 0, types: 'Sale' }
  );
  
  // Try the marketplaces endpoint to see what marketplaces are available
  await testEndpoint(
    `https://api-mainnet.magiceden.dev/v3/marketplaces`
  );
  
  // Try looking at tokens for a specific collection
  if (foundCollectionId) {
    await testEndpoint(
      `https://api-mainnet.magiceden.dev/v3/rtp/${chain}/collections/${foundCollectionId}/tokens`,
      { limit: 5 }
    );
  }
  
  // Test: Try RPC API for Monad (alternative non-MagicEden source)
  await testEndpoint(
    `https://rpc-api.monad.network/`,
    { method: "eth_blockNumber", params: [], id: 1, jsonrpc: "2.0" }
  );
  
  // Test with solana structure (in case endpoints are mixed up)
  await testEndpoint(
    `https://api-mainnet.magiceden.dev/v2/collections/monad/activities`,
    { offset: 0, limit: 100 }
  );
  
  console.log("\n===== ALL TESTS COMPLETED =====");
}

// Run the tests
runTests().catch(console.error); 