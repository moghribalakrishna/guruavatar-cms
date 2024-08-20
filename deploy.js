require('dotenv').config({ path: '.env' });
const { NodeSSH } = require('node-ssh');
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

const zipSourceFiles = (source, out) => {
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
          '*.zip',
          '.env',
          '.git/**',
          'build/**',
          'public/uploads/**',
          'data/**',
          'config/env/**',
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
    console.log(`Ensuring Node.js version ${nodeVersion} is installed and active...`);
    const nvmInitAndNodeCheck = `
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
      [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
      nvm use ${nodeVersion}
      node --version
    `;
    
    const { stdout, stderr } = await sshExecute(nvmInitAndNodeCheck);
    
    if (stderr) {
      console.warn('Warning during Node.js version check:', stderr);
    }
    
    console.log(`Node.js version check output: ${stdout.trim()}`);
    
    // Extract version number from the output
    const versionMatch = stdout.match(/v(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      throw new Error(`Unable to determine Node.js version from output: ${stdout}`);
    }
    
    const actualVersion = versionMatch[1];
    console.log(`Extracted Node.js version: ${actualVersion}`);
    
    if (actualVersion !== nodeVersion) {
      throw new Error(`Node.js version mismatch. Expected ${nodeVersion}, got ${actualVersion}`);
    }
    
    console.log(`Node.js version ${nodeVersion} is active.`);
  } catch (error) {
    console.error(`Failed to ensure Node.js version ${nodeVersion}:`, error);
    throw error;
  }
}

async function checkDiskSpace(ssh) {
  const { stdout } = await sshExecute(`df -h $(dirname ${remoteDir}) | tail -n 1 | awk '{print $4}'`);
  const availableSpace = parseFloat(stdout);
  if (availableSpace < 1) {  // Less than 1GB available
    throw new Error(`Not enough disk space. Only ${stdout.trim()} available.`);
  }
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
      readyTimeout: 30000,
    });
    console.log('Connected successfully.');
  });
}

async function sshExecute(command, options = {}) {
  return retryOperation(async () => {
    const { stdout, stderr } = await ssh.execCommand(command, {
      ...options,
      execOptions: {
        ...options.execOptions,
        shell: '/bin/bash -l'  // Use a login shell
      }
    });
    if (stderr) {
      console.warn('Command completed with warnings:', stderr);
    }
    return { stdout, stderr };
  });
}

async function checkStrapiInstallation(ssh) {
  console.log('Checking for existing Strapi installation...');
  const { stdout } = await sshExecute(`
    if [ -f "${remoteDir}/package.json" ] && grep -q '"strapi"' "${remoteDir}/package.json"; then
      echo "installed"
    else
      echo "not_installed"
    fi
  `);
  return stdout.trim() === 'installed';
}

async function ensureRemoteDir(ssh) {
  console.log(`Ensuring remote directory ${remoteDir} exists...`);
  await sshExecute(`mkdir -p ${remoteDir}`);
}

async function ensureUploadsDirectory(ssh) {
  console.log('Ensuring uploads directory exists...');
  await sshExecute(`
    mkdir -p ${remoteDir}/public/uploads &&
    chmod 755 ${remoteDir}/public/uploads
  `);
}

async function backupRemoteDir(ssh) {
  console.log('Backing up remote directory...');
  const backupCommand = `
    if [ -d "${remoteDir}" ] && [ "$(ls -A ${remoteDir})" ]; then
      backup_dir="${remoteDir}_backup_$(date +%Y%m%d_%H%M%S)"
      cp -R ${remoteDir} $backup_dir
      echo $backup_dir
    else
      echo "no_backup_needed"
    fi
  `;
  const { stdout } = await sshExecute(backupCommand);
  return stdout.trim();
}

async function updateRemoteProject(ssh, localZip, remoteDir) {
  await ssh.putFile(localZip, `${remoteDir}/update.zip`);
  await sshExecute(`
    cd ${remoteDir} &&
    unzip -o update.zip -x "public/uploads/*" "config/env/*" &&
    rm update.zip
  `);
}

async function buildRemoteProject(ssh, remoteDir) {
  console.log('Installing dependencies and building the project...');
  const buildCommand = `
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
    nvm use ${nodeVersion}
    cd ${remoteDir}
    npm install
    NODE_ENV=production npm run build
  `;
  await sshExecute(buildCommand);
}

async function updatePM2Startup(ssh) {
  console.log('Updating PM2 startup script...');
  const updateCommands = `
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
    nvm use ${nodeVersion}
    pm2 unstartup
    pm2 startup
  `;
  await sshExecute(updateCommands);
}

async function restartStrapi(ssh) {
  console.log('Restarting Strapi with PM2...');
  const startCommands = `
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
    nvm use ${nodeVersion}
    export PATH=$(npm bin):$PATH
    pm2 describe strapi-app > /dev/null 2>&1
    if [ $? -eq 0 ]; then
      pm2 reload strapi-app --update-env
    else
      pm2 start npm --name "strapi-app" -- run start
    fi
    pm2 save
  `;
  await sshExecute(startCommands, { cwd: remoteDir });
  
  // Verify the Node.js version used by PM2
  const { stdout } = await sshExecute('pm2 info strapi-app | grep "node.js version"');
  console.log('PM2 Node.js version:', stdout.trim());
  
  if (!stdout.includes(nodeVersion)) {
    console.warn(`Warning: PM2 is not using the expected Node.js version. Expected ${nodeVersion}, got ${stdout.trim()}`);
  }
}

async function deploy() {
  let backupDir = '';
  try {
    validateEnvironment();

    console.log('Zipping source files...');
    await zipSourceFiles('.', 'strapi-source.zip');

    await sshConnect();

    await checkDiskSpace(ssh);

    await ensureRemoteDir(ssh);

    const strapiInstalled = await checkStrapiInstallation(ssh);
    if (!strapiInstalled) {
      console.error('Strapi is not installed in the target directory. Please set up Strapi manually before running this deployment script.');
      process.exit(1);
    }

    await ensureNodeVersion(ssh);

    backupDir = await backupRemoteDir(ssh);
    if (backupDir !== 'no_backup_needed') {
      console.log(`Backup created at: ${backupDir}`);
    } else {
      console.log('No backup needed (directory is empty or doesn\'t exist).');
    }

    console.log('Updating remote project...');
    await updateRemoteProject(ssh, 'strapi-source.zip', remoteDir);

    console.log('Ensuring uploads directory...');
    await ensureUploadsDirectory(ssh);

    console.log('Building the project on the remote server...');
    await buildRemoteProject(ssh, remoteDir);

    await setCorrectPermissions(ssh);

    await restartStrapi(ssh);
    await updatePM2Startup(ssh);

    console.log('Deployment completed successfully!');
  } catch (error) {
    console.error('Deployment failed:', error);
    if (ssh.isConnected() && backupDir && backupDir !== 'no_backup_needed') {
      console.log('Attempting rollback...');
      try {
        await sshExecute(`rm -rf ${remoteDir} && mv ${backupDir} ${remoteDir}`);
        console.log('Rollback completed.');
        await restartStrapi(ssh);
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    } else {
      console.error('Cannot perform rollback: No valid backup or not connected to server');
    }
  } finally {
    if (ssh.isConnected()) {
      ssh.dispose();
    }

    // Clean up local zip files
    try {
      if (fs.existsSync('strapi-source.zip')) await fsp.unlink('strapi-source.zip');
    } catch (cleanupError) {
      console.error('Error cleaning up local zip files:', cleanupError);
    }
  }
}

// Run the deployment
deploy().catch(console.error);