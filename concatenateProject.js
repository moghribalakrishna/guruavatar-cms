const fs = require('fs');
const path = require('path');

function concatenateDirectory(sourceDir, outputPath, outputFormat) {
  let concatenatedContent = '';
  let fileCount = 0;
  let structureInfo = '';

  // Exclude directories and files
  const excludePaths = new Set(['node_modules', '.cache', 'build', 'public', '.git', 'concatenateProject.js', 'guruavatar-cms*', 'package-lock.json', 'yarn.lock', 'extensions']);

  // Include only these file extensions
  const includeExtensions = new Set(['.js', '.json', '.md', '.env']);

  // Directories specific to Strapi
  const directoriesToProcess = ['api', 'components', 'config', 'extensions'];

  function processDirectory(currentPath, relativePath = '', depth = 0) {
    try {
      const files = fs.readdirSync(currentPath).sort((a, b) => {
        const aPath = path.join(currentPath, a);
        const bPath = path.join(currentPath, b);
        const aIsDir = fs.statSync(aPath).isDirectory();
        const bIsDir = fs.statSync(bPath).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      files.forEach(file => {
        const fullPath = path.join(currentPath, file);
        const relativeFilePath = path.join(relativePath, file);
        const ext = path.extname(file).toLowerCase();

        if (excludePaths.has(file)) {
          return;
        }

        const stats = fs.lstatSync(fullPath);

        if (stats.isDirectory()) {
          structureInfo += `${'  '.repeat(depth)}${file}/\n`;
          processDirectory(fullPath, relativeFilePath, depth + 1);
        } else if (includeExtensions.has(ext) && stats.isFile()) {
          structureInfo += `${'  '.repeat(depth)}${file}\n`;
          try {
            let content = fs.readFileSync(fullPath, 'utf8');
            // Minimal processing to maintain readability
            content = content.replace(/^\s*\n/gm, '').trim();
            concatenatedContent += `\n\n// File: ${relativeFilePath}\n${content}\n`;
            fileCount++;
          } catch (readErr) {
            console.error(`Error reading file ${fullPath}:`, readErr);
          }
        }
      });
    } catch (err) {
      console.error(`Error processing directory ${currentPath}:`, err);
    }
  }

  // Process specific Strapi directories
  directoriesToProcess.forEach(dir => {
    const dirPath = path.join(sourceDir, dir);
    if (fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory()) {
      processDirectory(dirPath, dir);
    }
  });

  if (fileCount === 0) {
    throw new Error('No files were processed. Check your include/exclude settings and directory structure.');
  }

  // Prepare the final content with structure information
  const header = `// Strapi Project Structure:\n/*\n${structureInfo}*/\n\n// Concatenated Content:\n`;
  let finalContent = header + concatenatedContent;

  // Add appropriate wrapper based on the output format
  switch (outputFormat) {
    case '.ts':
      finalContent = `// TypeScript Concatenated Strapi Project Files\n${finalContent}`;
      break;
    case '.js':
      finalContent = `// JavaScript Concatenated Strapi Project Files\n${finalContent}`;
      break;
    case '.html':
      finalContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Concatenated Strapi Project Files</title>
</head>
<body>
    <h1>Concatenated Strapi Project Files</h1>
    <pre>${finalContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`;
      break;
    default:
      throw new Error('Unsupported output format');
  }

  try {
    fs.writeFileSync(outputPath, finalContent);
    console.log(`Concatenation completed. Output file: ${outputPath}`);
    console.log(`Total files processed: ${fileCount}`);
    console.log(`Output file size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
  } catch (writeErr) {
    console.error('Error writing output file:', writeErr);
    throw writeErr;
  }
}

// Define the source directory and output file
const sourceDir = path.join(__dirname, '.');
const outputFormat = '.js'; // Change this to '.ts' or '.html' as needed
const outputFilePath = path.join(__dirname, `guruavatar-cms${outputFormat}`);

// Call the function to concatenate the directory
try {
  concatenateDirectory(sourceDir, outputFilePath, outputFormat);
  console.log('Concatenation completed successfully');
} catch (err) {
  console.error('Error during concatenation:', err);
  process.exit(1);
}