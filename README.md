# Discord NFT Sales Bot for Monad

A Discord bot that tracks and notifies about NFT sales on the Monad blockchain.

## Features

- Track multiple NFT collections per server
- Server-specific configuration and tracking
- Automatic notifications of new sales in designated channels
- Collection-based caching to avoid duplicate notifications
- Whitelist system to restrict bot usage to specific Discord servers

## Commands

- `/track <channel> <collection>` - Start tracking sales for a specific collection in the specified channel
- `/untrack <collection>` - Stop tracking a collection
- `/list` - Show all currently tracked collections
- `/checksales` - Force an immediate check for new sales
- `/help` - Show available commands

## Setup

1. Clone the repository:
```
git clone https://github.com/YOUR-USERNAME/discord-nft-bot.git
cd discord-nft-bot
```

2. Install dependencies:
```
npm install
```

3. Create a `.env` file with your configuration:
```
DISCORD_TOKEN=your_discord_bot_token
DISCORD_APP_ID=your_discord_application_id
REFRESH_INTERVAL=60000
BOT_OWNER_ID=your_discord_id

# Server whitelist - comma-separated list of guild IDs (optional)
# If empty or commented out, bot will work in all servers
WHITELISTED_GUILDS=1234567890123456,9876543210987654
```

4. Start the bot:
```
node index.js
```

## License

MIT

## Credits

Made with 👽 Monalien Tech 