import type { IntegrationConnector, ConnectorMetadata } from './types';

/**
 * Connector Registry — central registry of all available integration connectors.
 *
 * Each connector registers itself here. The admin UI reads this registry
 * to display available connectors and their status.
 *
 * To add a new connector:
 * 1. Create a file in src/lib/integrations/connectors/your-connector.ts
 * 2. Implement the IntegrationConnector interface
 * 3. Call registerConnector() in this file
 */

const connectors = new Map<string, IntegrationConnector>();

/**
 * Register a connector with the integration hub.
 */
export function registerConnector(connector: IntegrationConnector): void {
  connectors.set(connector.metadata.id, connector);
}

/**
 * Get a registered connector by its ID.
 */
export function getConnector(id: string): IntegrationConnector | undefined {
  return connectors.get(id);
}

/**
 * Get all registered connectors.
 */
export function getAllConnectors(): IntegrationConnector[] {
  return Array.from(connectors.values());
}

/**
 * Get metadata for all registered connectors (safe to send to client).
 */
export function getAllConnectorMetadata(): ConnectorMetadata[] {
  return Array.from(connectors.values()).map((c) => c.metadata);
}

/**
 * Check if a connector is registered.
 */
export function isConnectorRegistered(id: string): boolean {
  return connectors.has(id);
}

// ---------------------------------------------------------------------------
// Registered Connectors
// ---------------------------------------------------------------------------

import { quickbooksOnlineConnector } from './connectors/quickbooks-online';
registerConnector(quickbooksOnlineConnector);

import { payrollExportConnector } from './connectors/payroll-export';
registerConnector(payrollExportConnector);

import { gustoConnector } from './connectors/gusto';
registerConnector(gustoConnector);
