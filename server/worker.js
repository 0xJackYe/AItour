import { httpServerHandler } from 'cloudflare:node';
import { env } from 'cloudflare:workers';
import { createApp } from './app.js';
import { configureWorkersAI } from './services/workersAi.js';

const PORT = 3000;
configureWorkersAI(env.AI);
const app = createApp();

app.listen(PORT);

export default httpServerHandler({ port: PORT });
