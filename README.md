# oe-bun-database-server

### Pre-run
1. Install bun (https://bun.sh/docs/installation)
2. Clone this repo
3. cd to the repo
4. Run `bun install`
5. Replace token in `Access Tokens/securityTokens.ts`  with your token (it is advised to use actual tokens)

### Importing old saves:
1. Obtain the saves from discord (https://discord.com/channels/1053774759244083280/1232242940391329793/1486703044094595072)
2. Put the text (.txt) files of *THE BUILDS SAVES* in the `(repo path)/db_files/saves`
2. Put the text (.txt) files of *THE PLAYER METADATA SAVES* in the `(repo path)/db_files/players`
4. after you run the app, the files will get `".processed"` added in the end (remove ".processed" if you want to import them again)
5. (optional) remove the text files if you don't need them anymore and you sure you got backups

### To run:
```bash
bun run index.ts
```

### Endpoints

| Method | Endpoint | Description | Parameters/Body |
| --- | --- | --- | --- |
| GET | /player/:id | Get player data entry by ID | id (player ID) |
| GET | /save/:id | Get the latest save for a player | id (player ID) |
| POST | /player | Insert or update player entry | { slotIndex: number, playerId: string, data: string, token: string } |
| POST | /save | Insert or update a save entry | { playerId: string, data: string, token: string } |