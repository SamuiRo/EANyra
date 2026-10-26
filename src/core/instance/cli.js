import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeInstance, migrateLegacyInstance } from './InstanceManager.js';
import dotenv from 'dotenv';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(projectRoot, '.env') });
const instanceDir = path.resolve(projectRoot, process.env.INSTANCE_DIR || 'instance');
const options = { projectRoot, instanceDir };

try {
  const action = process.argv[2];
  if (action === 'migrate') {
    const result = await migrateLegacyInstance(options);
    console.log(`Migrated ${result.moved.length} legacy locations into ${instanceDir}.`);
    console.log('Existing credential values and account/context contents were preserved.');
  } else if (action !== 'init') {
    throw new Error('Usage: node src/core/instance/cli.js <init|migrate>');
  }
  const result = await initializeInstance(options);
  console.log(`Instance ready: ${instanceDir} (${result.created.length} missing template files created).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
