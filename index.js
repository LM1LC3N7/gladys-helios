// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the HeliosApp of src/app.js). /data is read
// first: a party stop kept unconfirmed there leaves before anything else.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { HeliosApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new HeliosApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.shutdownApp());

logger.info('Starting the Helios easyControls integration...');
app.boot().catch((err) => logger.error('Reading /data failed', err));
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
