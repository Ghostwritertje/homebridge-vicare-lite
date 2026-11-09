import { join } from 'node:path';
import {
  API, Characteristic, CharacteristicValue, DynamicPlatformPlugin, HapStatusError, Logger, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Feature, RateLimitError, ViCareApi } from './vicare-api';

const DEFAULT_POLL_S = 300;
const MIN_POLL_S = 120;
const REFRESH_AFTER_COMMAND_MS = 20_000;
const DISCOVERY_RETRY_MIN_MS = 60_000;
const DISCOVERY_RETRY_MAX_MS = 30 * 60_000;
const ONE_TIME_CHARGE = 'heating.dhw.oneTimeCharge';

interface Item {
  id: string;
  kind: 'temperature' | 'switch';
  feature: string;
  defaultName: string;
}

const ITEMS: Item[] = [
  { id: 'dhw', kind: 'temperature', feature: 'heating.dhw.sensors.temperature.hotWaterStorage', defaultName: 'Hot water' },
  { id: 'room', kind: 'temperature', feature: 'heating.circuits.0.sensors.temperature.room', defaultName: 'Room temperature' },
  { id: 'outside', kind: 'temperature', feature: 'heating.sensors.temperature.outside', defaultName: 'Outside temperature' },
  { id: 'boost', kind: 'switch', feature: ONE_TIME_CHARGE, defaultName: 'Hot water boost' },
];

/**
 * Polls all heat pump features in one API call every `pollInterval` seconds (default 300 = ~290 calls/day,
 * the Basic plan allows 1450) and answers HomeKit from that cache. The switch runs the one-time hot water charge.
 */
export class ViCarePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly services = new Map<string, Service>();
  private readonly api_: ViCareApi;
  private readonly pollMs: number;

  private features?: Map<string, Feature>;
  private lastUpdate = 0;
  private model = 'Vitocal';
  private pollTimer?: NodeJS.Timeout;
  private discoveryRetryMs = DISCOVERY_RETRY_MIN_MS;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pollMs = Math.max(Number(config['pollInterval'] ?? DEFAULT_POLL_S), MIN_POLL_S) * 1000;
    this.api_ = new ViCareApi(String(config['clientId'] ?? ''), join(api.user.persistPath(), 'vicare-token.json'));

    this.api.on('didFinishLaunching', () => {
      if (!config['clientId']) {
        this.log.error('No clientId configured; the ViCare plugin is not starting.');
        return;
      }
      this.setUpAccessories();
      this.discover();
    });
    this.api.on('shutdown', () => clearTimeout(this.pollTimer));
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private name(item: Item): string {
    return String((this.config['names'] as Record<string, string> | undefined)?.[item.id] || item.defaultName);
  }

  private setUpAccessories() {
    const wanted = new Set<string>();
    for (const item of ITEMS) {
      const uuid = this.api.hap.uuid.generate(`vicare-lite:${item.id}`);
      wanted.add(uuid);
      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(this.name(item), uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Added accessory:', this.name(item));
      }
      this.attach(accessory, item);
    }
    const stale = [...this.cachedAccessories.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private attach(accessory: PlatformAccessory, item: Item) {
    const C = this.Characteristic;
    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Viessmann')
      .setCharacteristic(C.Model, this.model)
      .setCharacteristic(C.SerialNumber, item.id);

    if (item.kind === 'temperature') {
      const service = accessory.getService(this.Service.TemperatureSensor) || accessory.addService(this.Service.TemperatureSensor);
      service.setCharacteristic(C.Name, this.name(item));
      service.getCharacteristic(C.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 100 })
        .onGet(() => this.temperature(item.feature));
      this.services.set(item.id, service);
    } else {
      const service = accessory.getService(this.Service.Switch) || accessory.addService(this.Service.Switch);
      service.setCharacteristic(C.Name, this.name(item));
      service.getCharacteristic(C.On)
        .onGet(() => this.isActive(item.feature))
        .onSet((value) => this.setOneTimeCharge(value));
      this.services.set(item.id, service);
    }
  }

  private communicationFailure(): HapStatusError {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** Cached feature, or "No Response" in Home when the data is missing or too old. */
  private feature(name: string): Feature {
    const f = this.features?.get(name);
    if (!f || Date.now() - this.lastUpdate > 3 * this.pollMs + 60_000) {
      throw this.communicationFailure();
    }
    return f;
  }

  private temperature(name: string): CharacteristicValue {
    const value = this.feature(name).properties?.value?.value;
    if (typeof value !== 'number') {
      throw this.communicationFailure();
    }
    return value;
  }

  private isActive(name: string): CharacteristicValue {
    return this.feature(name).properties?.active?.value === true;
  }

  private async setOneTimeCharge(value: CharacteristicValue) {
    const on = value === true;
    try {
      await this.api_.command(ONE_TIME_CHARGE, on ? 'activate' : 'deactivate');
      this.log.info(`One-time hot water charge ${on ? 'started' : 'stopped'}`);
      const f = this.features?.get(ONE_TIME_CHARGE);
      if (f?.properties?.active) {
        f.properties.active.value = on;
      }
      this.schedulePoll(REFRESH_AFTER_COMMAND_MS);
    } catch (error) {
      this.log.warn(`Could not ${on ? 'start' : 'stop'} the one-time hot water charge: ${error}`);
      throw this.communicationFailure();
    }
  }

  private async discover() {
    try {
      const { model, gatewayType } = await this.api_.discover();
      this.model = model;
      this.log.info(`Found ViCare device ${model} via ${gatewayType}; polling every ${this.pollMs / 1000}s`);
      for (const accessory of this.cachedAccessories.values()) {
        accessory.getService(this.Service.AccessoryInformation)?.updateCharacteristic(this.Characteristic.Model, model);
      }
    } catch (error) {
      const wait = error instanceof RateLimitError ? error.retryAt.getTime() - Date.now() : this.discoveryRetryMs;
      this.log.warn(`Could not discover the ViCare device (${error instanceof Error ? error.message : error}); ` +
        `retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.discover(), Math.max(wait, DISCOVERY_RETRY_MIN_MS));
      this.discoveryRetryMs = Math.min(this.discoveryRetryMs * 2, DISCOVERY_RETRY_MAX_MS);
      return;
    }
    this.poll();
  }

  private schedulePoll(ms: number) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    let next = this.pollMs;
    try {
      this.features = await this.api_.features();
      this.lastUpdate = Date.now();
      this.push();
    } catch (error) {
      if (error instanceof RateLimitError) {
        next = Math.max(error.retryAt.getTime() - Date.now(), this.pollMs);
      }
      this.log.warn(`Could not read the ViCare features: ${error instanceof Error ? error.message : error}`);
    }
    this.schedulePoll(next);
  }

  /** Pushes fresh values to HomeKit so the Home app shows them without asking. */
  private push() {
    for (const item of ITEMS) {
      const service = this.services.get(item.id);
      try {
        if (item.kind === 'temperature') {
          service?.updateCharacteristic(this.Characteristic.CurrentTemperature, this.temperature(item.feature));
        } else {
          service?.updateCharacteristic(this.Characteristic.On, this.isActive(item.feature));
        }
      } catch {
        this.log.debug(`No value for ${item.feature}`);
      }
    }
    this.log.debug(`ViCare updated: ${ITEMS.map((i) => `${i.id}=${JSON.stringify(
      this.features?.get(i.feature)?.properties?.[i.kind === 'switch' ? 'active' : 'value']?.value)}`).join(' ')}`);
  }
}
