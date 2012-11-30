/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Chrome extension type.
 *
 * @author benvanik@google.com (Ben Vanik)
 */


/**
 * Chrome extension.
 *
 * @constructor
 */
var Extension = function() {
  /**
   * Current options values.
   * These are only ever modified by using the {@see #setOptions} call.
   * @type {!Options}
   * @private
   */
  this.options_ = new Options();
  this.options_.load();

  chrome.tabs.onActivated.addListener(
      this.tabActivated_.bind(this));
  chrome.tabs.onUpdated.addListener(
      this.tabUpdated_.bind(this));
  chrome.pageAction.onClicked.addListener(
      this.pageActionClicked_.bind(this));

  // Listen for commands from content scripts.
  chrome.extension.onConnect.addListener(function(port) {
    if (port.name == 'injector') {
      port.onMessage.addListener(this.pageMessageReceived_.bind(this));
    }
  }.bind(this));
};


/**
 * Gets the current extension options.
 * The returned object should not be modified.
 * @return {!Options} Options.
 */
Extension.prototype.getOptions = function() {
  return this.options_;
};


/**
 * Sets new options values, reloading the extension as required.
 * @param {!Options} value New options.
 */
Extension.prototype.setOptions = function(value) {
  this.cleanup();
  this.options_ = value;
  this.options_.save();
  this.setup();
};


/**
 * Sets up the extension in the browser.
 * This will add the (optional) page actions and browser actions.
 */
Extension.prototype.setup = function() {
  var options = this.getOptions();

  // Add context menu items.
  if (options.showContextMenu) {
    // chrome.contextMenus.create
  }

  // Bind for devtools events.
  if (options.showDevPanel) {
  }
};


/**
 * Cleans up the extension, removing all injected bits.
 */
Extension.prototype.cleanup = function() {
  // Remove all context menu items.
  chrome.contextMenus.removeAll();
};


/**
 * Updates the page state (cookie, action visibility, etc).
 * @param {number} tabId Tab ID.
 * @param {string} tabUrl Tab URL.
 * @private
 */
Extension.prototype.updatePageState_ = function(tabId, tabUrl) {
  /**
   * Name of the cookie that contains the options for the injection.
   * The data is just a blob GUID that is used to construct a URL to the blob
   * exposed by the extension.
   * @const
   * @type {string}
   */
  var WTF_OPTIONS_COOKIE = 'wtf';

  var options = this.getOptions();

  // Get page URL.
  var pageUrl = URI.canonicalize(tabUrl);
  if (pageUrl.lastIndexOf('blob:') == 0 ||
      pageUrl.lastIndexOf('view-source:') == 0) {
    // Ignore blob: URLs.
    return;
  }
  var parsedUrl = URI.parse(pageUrl);
  if (parsedUrl.scheme.lastIndexOf('chrome') == 0) {
    // Ignore chrome*:// URIs - they'll error.
    return;
  }

  // Get tab toggle status.
  var status = options.getPageStatus(pageUrl);
  var pageOptions = options.getPageOptions(pageUrl);

  // Create an exported blob URL that the content script can access.
  // To save on cookie space send only the UUID.
  var pageOptionsBlob = new Blob([JSON.stringify(pageOptions)]);
  var pageOptionsUuid = webkitURL.createObjectURL(pageOptionsBlob);
  pageOptionsUuid =
      pageOptionsUuid.substr(pageOptionsUuid.lastIndexOf('/') + 1);

  // Add or remove document cookie.
  // This tells the content script to inject stuff.
  if (status == PageStatus.WHITELISTED) {
    var urlPath = parsedUrl.path;
    chrome.cookies.set({
      url: pageUrl,
      name: WTF_OPTIONS_COOKIE,
      value: pageOptionsUuid,
      path: urlPath
    });
  } else {
    chrome.cookies.remove({
      url: pageUrl,
      name: WTF_OPTIONS_COOKIE
    });
  }

  if (options.showPageAction) {
    // Determine UI title/icon.
    var title;
    var icon;
    switch (status) {
      case PageStatus.NONE:
        title = 'Enable Web Tracing Framework on this page';
        icon = 'pageAction';
        break;
      case PageStatus.BLACKLISTED:
        title = 'Enable Web Tracing Framework on this page';
        icon = 'pageActionDisabled';
        break;
      case PageStatus.WHITELISTED:
        title = 'Disable Web Tracing Framework on this page';
        icon = 'pageActionEnabled';
        break;
    }

    // Setup page action.
    chrome.pageAction.setTitle({
      tabId: tabId,
      title: title
    });
    chrome.pageAction.setIcon({
      tabId: tabId,
      path: '/assets/icons/' + icon + '19.png'
    });
    chrome.pageAction.show(tabId);
  } else {
    // Hide page action.
    chrome.pageAction.hide(tabId);
  }
};


/**
 * Handles tab activation events.
 * @param {!Object} activeInfo Activate information.
 * @private
 */
Extension.prototype.tabActivated_ = function(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, (function(tab) {
    this.updatePageState_(tab.id, tab.url);
  }).bind(this));
};


/**
 * Handles tab update events.
 * @param {number} tabId Tab ID.
 * @param {!Object} changeInfo Change information.
 * @param {!Object} tab Tab.
 * @private
 */
Extension.prototype.tabUpdated_ = function(tabId, changeInfo, tab) {
  this.updatePageState_(tabId, tab.url);
};


/**
 * Handles clicks on the page action icon.
 * @param {!Object} tab Tab clicked on.
 * @private
 */
Extension.prototype.pageActionClicked_ = function(tab) {
  var options = this.getOptions();

  // Canonicalize URL. This makes matching easier.
  var pageUrl = URI.canonicalize(tab.url);

  // Perform toggling.
  var status = options.getPageStatus(pageUrl);
  switch (status) {
    case PageStatus.NONE:
    case PageStatus.BLACKLISTED:
      options.whitelistPage(pageUrl);
      break;
    case PageStatus.WHITELISTED:
      options.blacklistPage(pageUrl);
      break;
  }

  // Force update the page action ASAP.
  this.updatePageState_(tab.id, tab.url);

  // Reload (and inject).
  chrome.tabs.reload(tab.tabId, {
    bypassCache: true
  });
};


/**
 * Handles incoming messages from injector content scripts.
 * @param {!Object} msg Message.
 * @param {!Port} port Port the message was received on.
 * @private
 */
Extension.prototype.pageMessageReceived_ = function(msg, port) {
  var tab = port.sender.tab;
  if (!tab) {
    return;
  }

  var options = this.getOptions();
  var pageUrl = URI.canonicalize(tab.url);

  switch (msg['command']) {
    case 'reload':
      this.updatePageState_(tab.id, tab.url);
      chrome.tabs.reload(tab.id, {
        bypassCache: true
      });
      break;
    case 'save_settings':
      options.setPageOptions(
          pageUrl,
          JSON.parse(msg['content']));
      break;
  }
};