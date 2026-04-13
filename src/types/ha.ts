/**
 * Types for Home Assistant WebSocket API interactions.
 */

/** Represents the state of a single Home Assistant entity. */
export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

/** Parameters for calling a Home Assistant service. */
export interface HAServiceCall {
  domain: string;
  service: string;
  service_data?: Record<string, unknown>;
  target?: {
    entity_id?: string | string[];
    device_id?: string | string[];
    area_id?: string | string[];
  };
}

/** Home Assistant connection status. */
export type HAConnectionState = "connected" | "disconnected" | "connecting";

/** Home Assistant area from the area registry. */
export interface HAArea {
  area_id: string;
  name: string;
  picture: string | null;
}

/** Configuration returned by HA's get_config call. */
export interface HAConfig {
  latitude: number;
  longitude: number;
  elevation: number;
  unit_system: Record<string, string>;
  location_name: string;
  time_zone: string;
  version: string;
  state: string;
}
