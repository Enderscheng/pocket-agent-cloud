import worker from '../worker.js';
import { runTests } from './tests.mjs';
import { runVoiceTests } from './voice-tests.mjs';
console.log(await runTests(worker));
console.log(await runVoiceTests(worker));
