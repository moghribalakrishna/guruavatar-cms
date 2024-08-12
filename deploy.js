require('dotenv').config({ path: '.env' });
const { NodeSSH } = require('node-ssh');
const { exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const archiver = require('archiver');
const path = require('path');

const ssh = new NodeSSH();
const config = {
  host: process.env.DEPLOY_HOST,
  username: process.env.DEPLOY_USER,
  password: process.env.DEPLOY_PASSWORD,
};
const remoteDir = process.env.REMOTE_DIR;
const nodeVersion = process.env.NODE_VERSION || '20.16.0';

const requiredEnvVars = ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_PASSWORD', 'REMOTE_DIR'];

function validateEnvironment() {
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`${envVar} is not set in the environment variables.`);
    }
  }
  
  if (!fs.existsSync(path.resolve(process.cwd(), 'package.json'))) {
    throw new Error('package.json not found. Are you in the correct directory?');
  }
}

const executeCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${command}\n${error}`);
        reject(error);
      } else {
        if (stderr) {
          console.warn(`Command stderr: ${stderr}`);
        }
        console.log(`Command output: ${stdout}`);
        resolve({ stdout, stderr });
      }
    });
  });
};

const zipProject = (source, out) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(out);
  return new Promise((resolve, reject) => {
    archive
      .glob('**/*', {
        cwd: source,
        ignore: [
          'node_modules/**',
          '.cache/**',
          '.tmp/**',
          'build/**',
          '*.zip',
          '.env',
          '.git/**'
        ]
      })
      .on('error', err => reject(err))
      .pipe(stream);
    stream.on('close', () => resolve());
    archive.finalize();
  });
};

async function ensureNodeVersion(ssh) {
  try {
    console.log(`Ensuring Node.js version ${nodeVersion} is installed...`);
    const loadNvmCommand = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"';
    await sshExecute(`${loadNvmCommand} && nvm install ${nodeVersion} && nvm use ${nodeVersion} && nvm alias default ${nodeVersion}`);
    console.log(`Node.js version ${nodeVersion} installed successfully.`);
  } catch (error) {
    console.error(`Failed to ensure Node.js version ${nodeVersion}:`, error);
    throw error;
  }
}

async function ensureStrapiInstalled(ssh) {
  try {
    console.log('Checking for Strapi installation...');
    const { stdout: strapiCheck } = await sshExecute('strapi version');
    if (!strapiCheck) {
      console.log('Strapi not found. Installing Strapi...');
      await sshExecute('npm install -g @strapi/strapi');
      console.log('Strapi installed successfully.');
    } else {
      console.log('Strapi is already installed:', strapiCheck);
    }
  } catch (error) {
    console.error('Failed to ensure Strapi is installed:', error);
    throw error;
  }
}

async function checkDiskSpace(ssh) {
  const { stdout } = await sshExecute(`df -h ${remoteDir} | tail -n 1 | awk '{print $4}'`);
  const availableSpace = parseFloat(stdout);
  if (availableSpace < 1) {  // Less than 1GB available
    throw new Error(`Not enough disk space. Only ${stdout.trim()} available.`);
  }
}

async function backupDatabase(ssh) {
  // This is a placeholder. Implement according to your database setup.
  console.log('Backing up database...');
  // await sshExecute('pg_dump strapidb > strapidb_backup.sql');
}

async function setCorrectPermissions(ssh) {
  await sshExecute(`chown -R ${config.username}:${config.username} ${remoteDir}`);
  await sshExecute(`chmod -R 755 ${remoteDir}`);
}

async function retryOperation(operation, maxRetries = 3, delay = 5000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Operation failed, retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function sshConnect() {
  return retryOperation(async () => {
    console.log('Connecting to remote server...');
    await ssh.connect({
      ...config,
      tryKeyboard: true,
      readyTimeout: 30000, // Increase timeout to 30 seconds
    });
    console.log('Connected successfully.');
  });
}

async function sshExecute(command, options = {}) {
  return retryOperation(async () => {
    const { stdout, stderr } = await ssh.execCommand(command, options);
    if (stderr) {
      console.warn('Command completed with warnings:', stderr);
    }
    return { stdout, stderr };
  });
}

async function deploy() {
  try {
    validateEnvironment();

    console.log('Checking local dependencies...');
    await executeCommand('npm ci --only=prod');

    console.log('Building Strapi project...');
    const buildResult = await executeCommand('NODE_ENV=production npm run build');
    if (buildResult.stderr) {
      console.warn('Build process completed with warnings:', buildResult.stderr);
    }

    console.log('Zipping the project directory (excluding unnecessary files)...');
    await zipProject('.', 'strapi-project.zip');

    await sshConnect();

    await checkDiskSpace(ssh);

    console.log('Backing up remote directory...');
    const backupCommand = `cp -R ${remoteDir} ${remoteDir}_backup_$(date +%Y%m%d_%H%M%S)`;
    await sshExecute(backupCommand);

    await backupDatabase(ssh);
    await ensureNodeVersion(ssh);
    await ensureStrapiInstalled(ssh);

    console.log('Ensuring npm is up to date...');
    const loadNvmCommand = `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh" && nvm use ${nodeVersion}`;
    await sshExecute(`${loadNvmCommand} && npm install -g npm@latest`);

    console.log('Transferring files...');
    await retryOperation(async () => {
      await ssh.putFile('strapi-project.zip', `${remoteDir}/strapi-project.zip`);
      console.log('strapi-project.zip transferred successfully');
    });

    console.log('Unzipping and setting up the Strapi project...');
    const setupCommands = `
      cd ${remoteDir} &&
      unzip -o strapi-project.zip -d . &&
      rm strapi-project.zip &&
      ${loadNvmCommand} &&
      npm ci --only=prod
    `;
    await sshExecute(setupCommands, { cwd: remoteDir });

    await setCorrectPermissions(ssh);

    console.log('Starting the Strapi application with PM2...');
    const startCommands = `
      export PATH=$PATH:/usr/local/bin:$(npm bin -g) &&
      pm2 stop strapi-app || true &&
      pm2 delete strapi-app || true &&
      NODE_ENV=production pm2 start npm --name "strapi-app" -- run start
    `;
    await sshExecute(`${loadNvmCommand} && ${startCommands}`, { cwd: remoteDir });

    console.log('Deployment completed successfully!');
  } catch (error) {
    console.error('Deployment failed:', error);
    if (ssh.isConnected()) {
      console.log('Attempting rollback...');
      try {
        await sshExecute(`rm -rf ${remoteDir} && mv ${remoteDir}_backup_* ${remoteDir}`);
        // Here you would also restore the database from the backup
        console.log('Rollback completed.');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    } else {
      console.error('Cannot perform rollback: Not connected to server');
    }
  } finally {
    if (ssh.isConnected()) {
      ssh.dispose();
    }

    // Clean up local zip files
    try {
      if (fs.existsSync('strapi-project.zip')) await fsp.unlink('strapi-project.zip');
    } catch (cleanupError) {
      console.error('Error cleaning up local zip files:', cleanupError);
    }
  }
}

// Run the deployment
deploy().catch(console.error);