# oe-bun-database-server

### Pre-run
1. Install bun (https://bun.sh/docs/installation)
2. Clone this repo
3. cd to the repo
4. Run `bun install`
5. Replace token in `Access Tokens/securityTokens.ts` with your token (it is advised to use actual tokens)

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
### Example files
Some data has been included in the example files to test processing,
Once you run index.ts, you can try accessing the data

PlayerData:
> 238427763, 894261194, 3162050105, 2880942160, 1745850275, 5243461283, 148819022

SaveData:
> playerID: 238427763, indices: 30, 31, 34, 35

### Endpoints

| Method | Endpoint | Description | Parameters/Body |
| --- | --- | --- | --- |
| GET | /overengineered/player/:id | Get player data entry by ID | id (player ID) |
| GET | /overengineered/save/:id | Get all saves for a player | id (player ID) |
| GET | /overengineered/save/:id/:index | Get the save at the given index for a player | id (player ID), index (slot ID)  |
| GET | /overengineered/save/:id/:index/:page | Get a segment page of the save at the given index for a player | id (player ID), index (slot ID), page (page index; starts from 0)  |
| POST | /overengineered/player | Insert or update player entry | { slotIndex: number, playerId: string, data: string, token: string } |
| POST | /overengineered/save | Insert or update a save entry | { playerId: string, data: string, token: string } |

### example
For dev environment, the <HOST_IP> will be http://localhost:1367

To request player data with ID "238427763" you'd need to use GET with endpoint:
```
<HOST_IP>:1367/overengineered/player/238427763
```
The result will be:
```json
{
    "player_id":"238427763",
    "data":"..."
}
```
To request all saves for player ID "238427763" you'd need to use GET with endpoint:
```
<HOST_IP>:1367/overengineered/save/238427763
```
The result will be:
```json
{
    "player_id":"238427763",
    "saves":[
        {...save1},
        {...save2}
    ]
}
```
To request a specific save index for player ID "238427763" you'd need to use GET with endpoint:
```
<HOST_IP>:1367/overengineered/save/238427763/30
```
The result will be:
```json
{
    "increment":31,
    "player_id":"238427763",
    "index":"30",
    "data":"..."
}
```

If there are duplicates then the first from the list will be taken.
