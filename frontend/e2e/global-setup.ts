import { execSync } from 'child_process'
import path from 'path'

const backendDir = path.resolve(process.cwd(), '../backend')
const scriptPath = path.join(backendDir, 'scripts', 'cleanup_e2e_data.py')

async function globalSetup() {
  try {
    execSync(`python3 "${scriptPath}"`, { stdio: 'pipe', timeout: 10000, cwd: backendDir })
  } catch {
    // ignore
  }
}

export default globalSetup
