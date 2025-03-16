/**
 * Example collections on Monad testnet for tracking
 * 
 * This file contains example collections you can track with the Discord buy bot.
 * To use these collections, run the bot and use the !track command with these addresses.
 */

// These are examples of known collections on Monad testnet
// Note: Check if these are still available when testing

const popularCollections = [
  {
    name: "MonadLoot",
    address: "0x5F8F9CE5F4A3196Ce9e8344C3CD48245C4991FF0",
    description: "MonadLoot collection on Monad testnet"
  },
  {
    name: "MonadPunks",
    address: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", 
    description: "MonadPunks collection on Monad testnet"
  },
  {
    name: "MonadApes",
    address: "0x60E4d786628Fea6478F785A6d7e704777c86a7c6",
    description: "MonadApes collection on Monad testnet"
  }
];

// Commands to track these collections:
console.log("To track the MonadLoot collection, use this command in Discord:");
console.log("!track 0x5F8F9CE5F4A3196Ce9e8344C3CD48245C4991FF0");

console.log("\nTo track MonadPunks collection, use:");
console.log("!track 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D");

console.log("\nTo track MonadApes collection, use:");
console.log("!track 0x60E4d786628Fea6478F785A6d7e704777c86a7c6");

// Export for potential future use in the main application
module.exports = popularCollections; 