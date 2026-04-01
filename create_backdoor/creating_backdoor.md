# Loki C2 - Electron Backdoor Automation

This module automates the process of embedding a backdoor into vulnerable Electron applications as well as running the loki C2 agent.

## How to use
1. Create the payload by using the `create_agent_payload.js`
2. Find vulnerable electron application using the [Guide](docs/vulnhunt/electronapps.md)
3. Get the `package.json` file of the application from the path `{ELECTRONAPP}\resources\app`
4. Move the payload generated(`app/`) to the `create_backdoor/` directory
5. Run the python program with
   ```shell
   python3 main.py
   ```
   - Enter the path of the package.json
   - If required enter the name for main.js as there might be file conflict(if prompted)
   - Zip the files if required(optional)
6. Copy all the files within the app and paste it into the `{ELECTRONAPP}\resources\app` which will replace the `package.json`

The program will also open at the same time and loki agent will be running in the background

### How this works
- With these changes when the executable of the electron app is executed will load in `init.js` on click / execution
- `init.js` reads in `package.json`
- `init.js` changes `"main":"init.js",` -> `"main":"main.js",`
  - `main.js` is Loki
- `init.js` spawns and disowns a new `qrlwallet.exe` which points to Loki
- __Loki is spawned in the background__
- `init.js` reads in `package.json` again
- `init.js` changes `"main":"main.js",` -> `"main":"index.js",`
  - `index.js"` is the real Electron application
- `init.js` spawns and disowns a new `qrlwallet.exe` which points to the real QRLWallet
- __Real Electron app is spawned, visible and operates as normal__
- When Electron app is exited by the user:
  - `init.js` catches the exit
  - `init.js` reads in `package.json` for a third time
  - `init.js` changes `"main":"index.js",` -> `"main":"init.js",`