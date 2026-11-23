import worker from '../worker.js';
import { runTests } from './tests.mjs';
import { runVoiceTests } from './voice-tests.mjs';
import { runDiscordTests } from './discord-tests.mjs';
console.log(await runTests(worker));
console.log(await runVoiceTests(worker));
console.log(await runDiscordTests(worker));
