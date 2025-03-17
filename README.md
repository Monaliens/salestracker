# Discord NFT Buy Bot for Monad

A Discord bot that sends notifications for NFT sales on the Monad blockchain.

## Features

- Track NFT sales from specific collections on Monad 
- Support for collection addresses
- Ephemeral responses (only visible to command user) to reduce chat clutter
- Fetches data from BlockVision API for Monad
- Multi-server support: Each Discord server can configure its own notification channel and collections
- Real-time notifications in your Discord server
- Collection info display with name, image and details (when available)
- Simple slash commands to manage tracked collections

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   DISCORD_TOKEN=your_discord_bot_token
   DISCORD_APP_ID=your_discord_application_id
   REFRESH_INTERVAL=60000
   BOT_OWNER_ID=your_discord_user_id
   ```

### Getting the Required Tokens/IDs

- **Discord Bot Token and Application ID**: 
  1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
  2. Create a new application
  3. Go to the "Bot" tab and click "Add Bot"
  4. Copy the token
  5. Your Application ID is on the "General Information" tab

- **Discord User ID (BOT_OWNER_ID)**:
  1. Enable Developer Mode in Discord settings
  2. Right-click your username and select "Copy ID"
  3. Add this ID to your .env file for the `BOT_OWNER_ID` variable

### Bot Permissions

When adding the bot to your server, it needs the following permissions:
- Read Messages/View Channels
- Send Messages
- Embed Links
- Read Message History
- Use Slash Commands
- Message Content Intent (enable this in the Bot settings on Discord Developer Portal)

## Running the Bot

```
npm start
```

## Usage Commands

This bot supports both legacy commands (!) and slash commands (/). Slash commands are preferred as they support ephemeral responses.

### Slash Commands (recommended)
- `/setchannel` - Set the current channel for NFT sale notifications (Admin only)
- `/track <collection>` - Start tracking sales for a collection (accepts collection addresses)
- `/untrack <collection>` - Stop tracking sales for a specific collection
- `/list` - Show all currently tracked collections
- `/help` - Show all available commands

### Legacy Commands (being phased out)
- `!setchannel` - Set the current channel for NFT sale notifications (Admin only)
- `!track <collection>` - Start tracking sales for a collection (accepts collection addresses)
- `!untrack <collection>` - Stop tracking sales for a specific collection
- `!list` - Show all currently tracked collections
- `!help` - Show all available commands

## Examples

### Setting up the bot:
1. Admin runs in the desired notification channel:
```
/setchannel
```

2. Then anyone can track collections by address:
```
/track 0x1234567890abcdef1234567890abcdef12345678
```

## Multi-Server Support

The bot stores configuration for each server separately, allowing different Discord servers to have their own:
- Dedicated notification channels
- Lists of tracked collections

All settings are saved between bot restarts.

## Notes

- The bot polls the BlockVision API at the interval specified in your `.env` file (default is 1 minute)
- The bot keeps track of processed sales to avoid duplicate notifications
- Slash command responses are ephemeral (only visible to the user who ran the command)
- Regular NFT sale notifications are public in the configured channel 
- The bot uses BlockVision API to track NFT activities on Monad 