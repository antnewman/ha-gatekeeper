# Getting Started

This guide walks you through installing, configuring, and running ha-gatekeeper for the first time.

---

## Prerequisites

Before you begin, you will need:

1. **Node.js 20 or later** -- [download](https://nodejs.org/)
2. **A running Home Assistant instance** -- accessible via WebSocket (default port 8123)
3. **A long-lived access token** -- generated from your Home Assistant profile

### Creating a Long-Lived Access Token

1. Open your Home Assistant instance in a browser.
2. Click your profile icon in the bottom-left corner.
3. Scroll to the "Long-Lived Access Tokens" section.
4. Click "Create Token", give it a name (e.g. "ha-gatekeeper"), and copy the token.
5. Store it securely. You will not be able to see it again.

---

## Installation

### Option A: Docker (recommended)

```bash
git clone https://github.com/antnewman/ha-gatekeeper.git
cd ha-gatekeeper
```

### Option B: Manual

```bash
git clone https://github.com/antnewman/ha-gatekeeper.git
cd ha-gatekeeper
npm install
npm run build
```

---

## Configuration

Copy the example configuration and edit it for your environment:

```bash
cp config.example.yaml config.yaml
```

Open `config.yaml` in your editor. The key sections to configure are:

### 1. Home Assistant Connection

```yaml
homeassistant:
  url: "ws://homeassistant.local:8123/api/websocket"
  token: "${HA_TOKEN}"
```

- Replace the URL with your Home Assistant instance address.
- The `${HA_TOKEN}` syntax reads the token from an environment variable. You can also paste the token directly, but environment variables are more secure.

### 2. Server Settings

```yaml
server:
  port: 8200
  host: "0.0.0.0"
  transport: "streamable-http"
```

The defaults work for most setups. Change the port if 8200 is already in use.

### 3. Policy Tiers

This is the most important section. You need to classify your entities into tiers:

| Tier | Use for | What happens |
|------|---------|-------------|
| 0 | Sensors, weather, read-only data | Executed immediately, no logging |
| 1 | Lights, switches, media players | Executed and logged |
| 2 | Thermostats, locks, alarms | Requires your approval via notification |
| 3 | Automations, scripts, critical switches | Blocked entirely |

You classify entities by **domain** (e.g. `light.*` for all lights) and can override individual entities:

```yaml
policy:
  default_tier: 3  # Anything not classified is blocked

  tiers:
    0:
      description: "Read-only"
      domains:
        - "sensor.*"
        - "binary_sensor.*"
        - "weather.*"

    1:
      description: "Logged"
      domains:
        - "light.*"
        - "switch.*"
        - "media_player.*"
      constraints:
        rate_limit:
          max_calls_per_entity_per_minute: 10

    2:
      description: "Confirmed"
      domains:
        - "climate.*"
        - "lock.*"
      constraints:
        rate_limit:
          max_calls_per_entity_per_minute: 3
        confirmation:
          method: "notification"
          timeout_seconds: 30
          notification_service: "notify.mobile_app_your_phone"
          message_template: "ha-gatekeeper: LLM wants to {{action}} on {{entity_id}}. Approve?"

    3:
      description: "Prohibited"
      domains:
        - "automation.*"
        - "script.*"

  entity_overrides:
    light.nursery: 2           # Baby's room requires confirmation
    switch.server_rack_pdu: 3  # Never let LLM control server power
    climate.office: 1          # Office thermostat is fine without confirmation
```

**Important:** The `default_tier: 3` setting means any entity not explicitly classified is blocked. This is the safe default. Classify entities you want the LLM to interact with, and everything else is automatically protected.

### 4. Confirmation Setup (Tier 2)

For Tier 2 actions to work, you need a notification service configured in Home Assistant. The most common setup uses the HA Companion App:

1. Install the Home Assistant Companion App on your phone.
2. In `config.yaml`, set `notification_service` to your device's notify service (e.g. `notify.mobile_app_your_phone`).
3. When the LLM requests a Tier 2 action, you will receive a notification on your phone to approve or deny.

The confirmation webhook server runs on port 8202 (MCP port + 2) by default. Approvals and denials are submitted to `POST /api/confirm/{token}` on this port.

### 5. Range Clamping (optional)

For Tier 2 entities with numeric values, you can set hard boundaries:

```yaml
constraints:
  range_clamp:
    climate.temperature:
      min: 15
      max: 25
```

If the LLM requests a temperature of 30C, it will be silently clamped to 25C and the adjustment logged.

See [configuration.md](configuration.md) for the full reference of every configuration option.

---

## Running the Server

### Docker

```bash
export HA_TOKEN="your-long-lived-access-token"
docker compose up -d
```

To view logs:

```bash
docker compose logs -f ha-gatekeeper
```

### Manual

```bash
export HA_TOKEN="your-long-lived-access-token"
npm start
```

For development with hot reload:

```bash
npm run dev
```

---

## Connecting an MCP Client

### Claude Desktop

Add ha-gatekeeper to your Claude Desktop MCP configuration. On macOS, edit `~/Library/Application Support/Claude/claude_desktop_config.json`. On Windows, edit `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "ha-gatekeeper": {
      "url": "http://localhost:8200/mcp"
    }
  }
}
```

Restart Claude Desktop. You should see ha-gatekeeper's tools available in the tool list.

### Other MCP Clients

Any MCP client that supports the Streamable HTTP transport can connect to `http://localhost:8200/mcp`. If your client only supports stdio transport, change `transport` in `config.yaml` to `"stdio"` and configure the client to launch ha-gatekeeper as a subprocess.

---

## Verifying It Works

### 1. Check the health endpoint

```bash
curl http://localhost:8201/health
```

You should see:

```json
{
  "status": "healthy",
  "circuit_breaker": "closed",
  "ha_connected": true,
  "ha_entity_count": 147,
  "uptime_seconds": 60,
  "last_tool_call": null,
  "error_rate_1h": 0,
  "version": "0.1.0"
}
```

### 2. Test a read operation

In your MCP client, try asking: "What is the temperature in the living room?"

The LLM should use the `get_entity_state` tool to read a temperature sensor. This is a Tier 0 operation, so it will execute immediately with no confirmation.

### 3. Test a control operation

Try: "Turn on the living room light."

If `light.*` is classified as Tier 1, the light will turn on and the action will be logged to the audit database.

### 4. Test a confirmation flow

Try: "Set the thermostat to 22 degrees."

If `climate.*` is classified as Tier 2, you will receive a notification on your phone. Approve it to see the action execute.

### 5. Test a prohibition

Try: "Restart Home Assistant."

This should be rejected immediately with a clear message that the action is prohibited by policy.

---

## Troubleshooting

### Cannot connect to Home Assistant

- Verify the WebSocket URL in `config.yaml` is correct.
- Ensure your long-lived access token is valid and not expired.
- Check that Home Assistant is accessible from the machine running ha-gatekeeper.
- If using Docker, ensure the container can reach your HA instance (check network settings).

### Entity not found errors

- Entity IDs must match exactly what Home Assistant uses (e.g. `light.living_room`, not `Living Room Light`).
- Run `list_entities` to see all available entities and their IDs.

### Confirmation notifications not arriving

- Verify `notification_service` in `config.yaml` matches your device's notify service.
- Check HA's notification settings and ensure the Companion App is configured.
- Look at the server logs for errors sending notifications.

### Circuit breaker tripped

- The circuit breaker opens after 3 consecutive failures to Home Assistant.
- Check HA's status and connectivity.
- The breaker will automatically attempt recovery after the configured health check interval.

---

## Next Steps

- Read the [configuration reference](configuration.md) for all available options.
- Read the [architecture guide](architecture.md) to understand how the policy engine works.
- Review `config.example.yaml` for a fully annotated example configuration.
