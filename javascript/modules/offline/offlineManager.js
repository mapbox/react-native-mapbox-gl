import { NativeModules, NativeEventEmitter } from 'react-native';
import { isUndefined, isFunction } from '../../utils';

import OfflineCreatePackOptions from './OfflineCreatePackOptions';
import OfflinePack from './OfflinePack';

const MapboxGL = NativeModules.MGLModule;
const MapboxGLOfflineManager = NativeModules.MGLOfflineModule;
export const OfflineModuleEventEmitter = new NativeEventEmitter(MapboxGLOfflineManager);

/**
 * OfflineManager implements a singleton (shared object) that manages offline packs.
 * All of this class’s instance methods are asynchronous, reflecting the fact that offline resources are stored in a database.
 * The shared object maintains a canonical collection of offline packs.
 */
class OfflineManager {
  constructor () {
    this._hasInitialized = false;
    this._offlinePacks = {};

    this._progressListeners = {};
    this._errorListeners = {};

    this._onProgress = this._onProgress.bind(this);
    this._onError = this._onError.bind(this);
  }

  /**
   * Creates and registers an offline pack that downloads the resources needed to use the given region offline.
   *
   * @example
   *
   * const progressListener = (offlineRegion, status) => console.log(offlineRegion, status);
   * const errorListener = (offlineRegion, err) => console.log(offlineRegion, err);
   *
   * await MapboxGL.offlineManager.createPack({
   *   name: 'offlinePack',
   *   styleURL: 'mapbox://...',
   *   minZoom: 14,
   *   maxZoom: 20,
   *   bounds: [[neLng, neLat], [swLng, swLat]]
   * }, progressListener, errorListener)
   *
   * @param  {OfflineCreatePackOptions} options Create options for a offline pack that specifices zoom levels, style url, and the region to download.
   * @param  {Callback=} progressListener Callback that listens for status events while downloading the offline resource.
   * @param  {Callback=} errorListener Callback that listens for status events while downloading the offline resource.
   * @return {void}
   */
  async createPack (options, progressListener, errorListener) {
    await this._initialize();

    const packOptions = new OfflineCreatePackOptions(options);

    if (this._offlinePacks[packOptions.name]) {
      throw new Error(`Offline pack with name ${packOptions.name} already exists.`);
    }

    this.subscribe(packOptions.name, progressListener, errorListener);
    const nativeOfflinePack = await MapboxGLOfflineManager.createPack(packOptions);
    this._offlinePacks[packOptions.name] = new OfflinePack(nativeOfflinePack);
  }

  /**
   * Retrieves the current status from a given pack that are stored in the database.
   *
   * @example
   * const status = await MapboxGL.offlineManager.getStatus('packName');
   *
   * @param  {String}  name  Name of the offline pack.
   * @return {Object} status Status object
   */
  async getPackStatus (name) {
    if (!name) {
      return;
    }

    await this._initialize();
    const offlinePack = this._offlinePacks[name];
    
    if (offlinePack) {
      const status = await MapboxGLOfflineManager.getPackStatus(name);
      return status;
    }
  }

  /**
   * Unregisters the given offline pack and allows resources that are no longer required by any remaining packs to be potentially freed.
   *
   * @example
   * await MapboxGL.offlineManager.deletePack('packName')
   *
   * @param  {String}  name  Name of the offline pack.
   * @return {void}
   */
  async deletePack (name) {
    if (!name) {
      return;
    }

    await this._initialize();

    const offlinePack = this._offlinePacks[name];
    if (offlinePack) {
      await MapboxGLOfflineManager.deletePack(name);
      delete this._offlinePacks[name];
    }
  }

  /**
   * Retrieves all the current offline packs that are stored in the database.
   *
   * @example
   * const offlinePacks = await MapboxGL.offlineManager.getPacks();
   *
   * @return {Array<OfflinePack>}
   */
  async getPacks () {
    await this._initialize();
    return Object.keys(this._offlinePacks).map((name) => this._offlinePacks[name]);
  }

  /**
   * Retrieves an offline pack that is stored in the database by name.
   *
   * @example
   * const offlinePack = await MapboxGL.offlineManager.getPack();
   *
   * @param  {String}  name  Name of the offline pack.
   * @return {OfflinePack}
   */
  async getPack (name) {
    await this._initialize();
    return this._offlinePacks[name];
  }

  /**
   * Sets the maximum number of Mapbox-hosted tiles that may be downloaded and stored on the current device.
   * The Mapbox Terms of Service prohibits changing or bypassing this limit without permission from Mapbox.
   *
   * @example
   * MapboxGL.offlineManager.setTileCountLimit(1000);
   *
   * @param {Number} limit Map tile limit count.
   * @return {void}
   */
  setTileCountLimit (limit) {
    MapboxGLOfflineManager.setTileCountLimit(limit);
  }

  /**
   * Sets the value at which download status events will be sent over the React Native bridge.
   * These events happening very very fast default is 500ms.
   *
   * @example
   * MapboxGL.setProgressEventThrottle(500);
   *
   * @param {Number} throttleValue event throttle value in ms.
   * @return {void}
   */
  setProgressEventThrottle (throttleValue) {
    MapboxGLOfflineManager.setProgressEventThrottle(throttleValue);
  }

  /**
   * Subscribe to download status/error events for the requested offline pack.
   * Note that createPack calls this internally if listeners are provided.
   *
   * @example
   * const progressListener = (offlinePack, status) => console.log(offlinePack, status)
   * const errorListener = (offlinePack, err) => console.log(offlinePack, err)
   * MapboxGL.offlineManager.subscribe('packName', progressListener, errorListener)
   *
   * @param  {String} packName           Name of the offline pack.
   * @param  {Callback} progressListener Callback that listens for status events while downloading the offline resource.
   * @param  {Callback} errorListener      Callback that listens for status events while downloading the offline resource.
   * @return {void}
   */
  subscribe (packName, progressListener, errorListener) {
    const totalProgressListeners = Object.keys(this._progressListeners).length;
    if (isFunction(progressListener)) {
      if (totalProgressListeners === 0) {
        OfflineModuleEventEmitter.addListener(MapboxGL.OfflineCallbackName.Progress, this._onProgress);
      }
      this._progressListeners[packName] = progressListener;
    }

    const totalErrorListeners = Object.keys(this._errorListeners).length;
    if (isFunction(errorListener)) {
      if (totalErrorListeners === 0) {
        OfflineModuleEventEmitter.addListener(MapboxGL.OfflineCallbackName.Error, this._onError);
      }
      this._errorListeners[packName] = errorListener;
    }
  }

  /**
   * Unsubscribes any listeners associated with the offline pack.
   * It's a good idea to call this on componentWillUnmount.
   *
   * @example
   * MapboxGL.offlineManager.unsubscribe('packName')
   *
   * @param  {String} packName Name of the offline pack.
   * @return {void}
   */
  unsubscribe (packName) {
    delete this._progressListeners[packName];
    delete this._errorListeners[packName];

    if (Object.keys(this._progressListeners).length === 0) {
      OfflineModuleEventEmitter.removeListener(MapboxGL.OfflineCallbackName.Progress, this._onProgress);
    }

    if (Object.keys(this._errorListeners).length === 0) {
      OfflineModuleEventEmitter.removeListener(MapboxGL.OfflineCallbackName.Error, this._onError);
    }
  }

  _initialize () {
    return new Promise(async (resolve, reject) => {
      if (this._hasInitialized) {
        return resolve(true);
      }

      try {
        const nativeOfflinePacks = await MapboxGLOfflineManager.getPacks();

        for (let nativeOfflinePack of nativeOfflinePacks) {
          const offlinePack = new OfflinePack(nativeOfflinePack);
          this._offlinePacks[offlinePack.name] = offlinePack;
        }
      } catch (e) {
        reject(e);
        return;
      }

      this._hasInitialized = true;
      return resolve(true);
    });
  }

  _onProgress (e) {
    const { name, state } = e.payload;

    if (!this._hasListeners(name, this._progressListeners)) {
      return;
    }

    const pack = this._offlinePacks[name];
    this._progressListeners[name](pack, e.payload);

    // cleanup listeners now that they are no longer needed
    if (state === MapboxGL.OfflinePackDownloadState.Complete) {
      this.unsubscribe(name);
    }
  }

  _onError (e) {
    const { name } = e.payload;

    if (!this._hasListeners(name, this._errorListeners)) {
      return;
    }

    const pack = this._offlinePacks[name];
    this._errorListeners[name](pack, e.payload);
  }

  _hasListeners (name, listenerMap) {
    return !isUndefined(this._offlinePacks[name]) && isFunction(listenerMap[name]);
  }
}

const offlineManager = new OfflineManager();
export default offlineManager;
