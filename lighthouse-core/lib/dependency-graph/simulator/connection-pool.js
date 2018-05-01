/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const NetworkAnalyzer = require('./network-analyzer');
const TcpConnection = require('./tcp-connection');

const DEFAULT_SERVER_RESPONSE_TIME = 30;
const TLS_SCHEMES = ['https', 'wss'];

module.exports = class ConnectionPool {
  /**
   * @param {LH.WebInspector.NetworkRequest[]} records
   * @param {Object=} options
   */
  constructor(records, options) {
    this._options = Object.assign(
      {
        rtt: undefined,
        throughput: undefined,
        additionalRttByOrigin: new Map(),
        serverResponseTimeByOrigin: new Map(),
      },
      options
    );

    if (!this._options.rtt || !this._options.throughput) {
      throw new Error('Cannot create pool with no rtt or throughput');
    }

    this._records = records;
    /** @type {Map<string, TcpConnection[]>} */
    this._connectionsByOrigin = new Map();
    /** @type {Map<LH.WebInspector.NetworkRequest, TcpConnection>} */
    this._connectionsByRecord = new Map();
    this._connectionsInUse = new Set();
    this._connectionReusedByRequestId = NetworkAnalyzer.estimateIfConnectionWasReused(records, {
      forceCoarseEstimates: true,
    });

    this._initializeConnections();
  }

  /**
   * @return {TcpConnection[]}
   */
  connectionsInUse() {
    return Array.from(this._connectionsInUse);
  }

  _initializeConnections() {
    const connectionReused = this._connectionReusedByRequestId;
    const additionalRttByOrigin = this._options.additionalRttByOrigin;
    const serverResponseTimeByOrigin = this._options.serverResponseTimeByOrigin;

    const recordsByOrigin = NetworkAnalyzer.groupByOrigin(this._records);
    for (const [origin, records] of recordsByOrigin.entries()) {
      const connections = [];
      const additionalRtt = additionalRttByOrigin.get(origin) || 0;
      const responseTime = serverResponseTimeByOrigin.get(origin) || DEFAULT_SERVER_RESPONSE_TIME;

      for (const record of records) {
        if (connectionReused.get(record.requestId)) continue;

        const isTLS = TLS_SCHEMES.includes(record.parsedURL.scheme);
        const isH2 = record.protocol === 'h2';
        const connection = new TcpConnection(
          this._options.rtt + additionalRtt,
          this._options.throughput,
          responseTime,
          isTLS,
          isH2
        );

        connections.push(connection);
      }

      if (!connections.length) {
        throw new Error(`Could not find a connection for origin: ${origin}`);
      }

      // Make sure each origin has 6 connections available
      // https://cs.chromium.org/chromium/src/net/socket/client_socket_pool_manager.cc?type=cs&q="int+g_max_sockets_per_group"
      while (connections.length < 6) connections.push(connections[0].clone());
      while (connections.length > 6) connections.pop();

      this._connectionsByOrigin.set(origin, connections);
    }
  }

  /**
   * @param {LH.WebInspector.NetworkRequest} record
   * @param {{ignoreObserved?: boolean}} options
   * @return {?TcpConnection}
   */
  acquire(record, options = {}) {
    if (this._connectionsByRecord.has(record)) {
      // @ts-ignore
      return this._connectionsByRecord.get(record);
    }

    const origin = String(record.parsedURL.securityOrigin());
    /** @type {TcpConnection[]} */
    const connections = this._connectionsByOrigin.get(origin) || [];
    // Sort connections by decreasing congestion window, i.e. warmest to coldest
    const sortedConnections = connections.sort((a, b) => b.congestionWindow - a.congestionWindow);

    const availableWarmConnection = sortedConnections.find(connection => {
      return connection.isWarm() && !this._connectionsInUse.has(connection);
    });
    const availableColdConnection = sortedConnections.find(connection => {
      return !connection.isWarm() && !this._connectionsInUse.has(connection);
    });

    const needsColdConnection = !options.ignoreObserved &&
        !this._connectionReusedByRequestId.get(record.requestId);
    const needsWarmConnection = !options.ignoreObserved &&
        this._connectionReusedByRequestId.get(record.requestId);

    let connectionToUse = availableWarmConnection || availableColdConnection;
    if (needsColdConnection) connectionToUse = availableColdConnection;
    if (needsWarmConnection) connectionToUse = availableWarmConnection;
    if (!connectionToUse) return null;

    this._connectionsInUse.add(connectionToUse);
    this._connectionsByRecord.set(record, connectionToUse);
    return connectionToUse;
  }

  /**
   * @param {LH.WebInspector.NetworkRequest} record
   */
  release(record) {
    const connection = this._connectionsByRecord.get(record);
    this._connectionsByRecord.delete(record);
    this._connectionsInUse.delete(connection);
  }
};
