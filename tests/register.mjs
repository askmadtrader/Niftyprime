// Lets plain Node run the app's pure modules (extensionless ESM imports) without a bundler.
import { register } from 'node:module';
register('./resolve-hook.mjs', import.meta.url);
