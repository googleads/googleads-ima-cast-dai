
const NAMESPACE = 'urn:x-cast:com.google.ads.ima.cast';

class Player {
  /**
   * Represents the receiver
   * @param {!Object} mediaElement - the cast media player element
   */
  constructor(mediaElement) {
    /**
     * the fallback stream to play if loading fails
     * @type {string}
     * @private
     * @const
     */
    this.backupStream_ = 'http://storage.googleapis.com/testtopbox-public/' +
        'video_content/bbb/master.m3u8';

    /**
     * the cast context object provided by the CAF framework.
     * @type {!Object}
     * @private
     * @const
     */
    this.castContext_ = cast.framework.CastReceiverContext.getInstance();

    /**
     * the player manager object, provided by the CAF framework.
     * @type {!Object}
     * @private
     * @const
     */
    this.playerManager_ = this.castContext_.getPlayerManager();

    /**
     * the video player contained within the cast media player element.
     * @type {!HTMLMediaElement}
     * @private
     * @const
     */
    this.mediaElement_ = mediaElement.getMediaElement();

    /**
     * This is the stream manager object for IMA SDK.
     * @type {?Object}
     * @private
     */
    this.streamManager_ = null;

    /**
     * Stores the timestamp where playback will start, in seconds, for
     * bookmarking.
     * @type {number}
     * @private
     */
    this.startTime_ = 0;

    /**
     * Stores an option to identify whether an ad is currently playing.
     * @type {boolean}
     * @private
     */
    this.adIsPlaying_ = false;

    /**
     * Stores the timestamp to seek to when ad completes, for snapback.
     * -1 indicates that snapback has not been requested.
     * @type {number}
     * @private
     */
    this.seekToTimeAfterAdBreak_ = -1;
  }

  /** Initializes CAF and IMA SDK */
  initialize() {
    // Map of namespace names to their types.
    const options = new cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[NAMESPACE] =
        cast.framework.system.MessageType.STRING;
    this.castContext_.start(options);
    this.streamManager_ =
        new google.ima.dai.api.StreamManager(this.mediaElement_);
  }

  /** Attaches event listeners and other callbacks. */
  setupCallbacks() {
    // Receives messages from sender app.
    this.castContext_.addCustomMessageListener(NAMESPACE, (event) => {
      this.processSenderMessage_(event.data);
    });

    this.attachPlayerManagerCallbacks_();
    this.attachStreamManagerListeners_();
  }

  /**
   * Parses messages from sender apps. The message is a comma separated
   * string consisting of a function name followed by a set of parameters.
   * @param {string} message - The raw message from the sender app.
   * @private
   */
  processSenderMessage_(message) {
    console.log('Received message from sender: ' + message);
    const messageArray = message.split(',');
    const method = messageArray[0];
    switch (method) {
      case 'bookmark':
        const time = parseFloat(messageArray[1]);
        const bookmarkTime = this.streamManager_.contentTimeForStreamTime(time);
        this.broadcast('bookmark,' + bookmarkTime);
        this.bookmark(time);
        break;
      case 'getContentTime':
        const contentTime = this.getContentTime();
        this.broadcast('contentTime,' + contentTime);
        break;
      default:
        this.broadcast('Message not recognized');
        break;
    }
  }

  /**
   * Attaches message interceptors and event listeners to connet IMA to CAF.
   * @private
   */
  attachPlayerManagerCallbacks_() {
    // This intercepts the CAF load process, to load the IMA stream manager and
    // make a DAI stream request. It then injests the stream URL into the
    // original LOAD message, before passing it to CAF
    this.playerManager_.setMessageInterceptor(
        cast.framework.messages.MessageType.LOAD, (request) => {
          return this.initializeStreamManager_(request);
        });

    // This intercepts CAF seek requests to cancel them in the case that an ad
    // is playing, and to modify them to enable snapback
    this.playerManager_.setMessageInterceptor(
        cast.framework.messages.MessageType.SEEK, (seekRequest) => {
          return this.processSeekRequest_(seekRequest);
        });

    // This passes ID3 events from the stream to the IMA to allow for updating
    // stream events on the fly in live streams
    this.playerManager_.addEventListener(
        cast.framework.events.EventType.ID3, (event) => {
          // pass ID3 events from the stream to IMA to update live stream
          // cuepoints
          this.streamManager_.processMetadata(
              'ID3', event.segmentData, event.timestamp);
        });

    this.playerManager_.addEventListener(
        [
          cast.framework.events.EventType.TIMED_METADATA_ENTER,
          cast.framework.events.EventType.TIMED_METADATA_CHANGED,
          cast.framework.events.EventType.TIMED_METADATA_EXIT,
        ],
        (event) => this.handleTimedMetadataEvent_(event));
  }

  /**
   * Handles timedmetadata updates from the player manager.
   * @param {!cast.framework.events.TimedMetadataEvent} event
   * @private
   */
  handleTimedMetadataEvent_(event) {
    if (!event.timedMetadataInfo) {
      return;
    }
    if (event.timedMetadataInfo.dashTimedMetadata &&
        event.timedMetadataInfo.dashTimedMetadata.eventElement) {
      this.streamManager_.processMetadata(
          event.timedMetadataInfo.dashTimedMetadata.schemeIdUri,
          event.timedMetadataInfo.dashTimedMetadata.eventElement.getAttribute(
              'messageData'),
          event.timedMetadataInfo.startTime);
    }
  }

  /**
   * Attaches IMA event managers
   * @private
   */
  attachStreamManagerListeners_() {
    // This fires at the beginning of each ad break
    this.streamManager_.addEventListener(
        google.ima.dai.api.StreamEvent.Type.AD_BREAK_STARTED, (event) => {
          this.startAdBreak_();
        });
    // This fires at the end of each ad break
    this.streamManager_.addEventListener(
        google.ima.dai.api.StreamEvent.Type.AD_BREAK_ENDED, (event) => {
          this.endAdBreak_();
        });
    // This fires periodically while ads are playing
    this.streamManager_.addEventListener(
        google.ima.dai.api.StreamEvent.Type.AD_PROGRESS, (event) => {
          this.updateAdProgress_(event);
        });

    // Log the quartile events to the console for debugging
    const quartileEvents = [
      google.ima.dai.api.StreamEvent.Type.STARTED,
      google.ima.dai.api.StreamEvent.Type.FIRST_QUARTILE,
      google.ima.dai.api.StreamEvent.Type.MIDPOINT,
      google.ima.dai.api.StreamEvent.Type.THIRD_QUARTILE,
      google.ima.dai.api.StreamEvent.Type.COMPLETE
    ];
    this.streamManager_.addEventListener(quartileEvents, (event) => {
      console.log(`IMA SDK Event: ${event.type}`);
    }, false);
  }

  /**
   * initializes the IMA StreamManager and issues a stream request.
   * @param {!Object} request - The request data object from the CAF sender
   * @return {!Promise<!Object>} - The request object with added stream
   *     information
   * @private
   */
  initializeStreamManager_(request) {
    return new Promise((resolve, reject) => {
      // Set media info and resolve promise on successful stream request
      this.streamManager_.addEventListener(
          google.ima.dai.api.StreamEvent.Type.LOADED, (event) => {
            this.broadcast('Stream request successful. Loading stream...');
            request.media.contentUrl = event.getStreamData().url;
            request.media.subtitles = event.getStreamData().subtitles;
            if (event.getStreamData().manifestFormat.toLowerCase() == 'dash') {
              request.media.contentType = 'application/dash+xml';
            }
            resolve(request);
          }, false);

      // Prepare backup stream and resolve promise on stream request error
      this.streamManager_.addEventListener(
          google.ima.dai.api.StreamEvent.Type.ERROR, (event) => {
            this.broadcast('Stream request failed. Loading backup stream...');
            request.media.contentUrl = this.backupStream_;
            resolve(request);
          }, false);

      // Request Stream
      const imaRequestData = request.media.customData;
      this.startTime_ = imaRequestData.startTime;
      const streamRequest = (imaRequestData.assetKey) ?
          new google.ima.dai.api.LiveStreamRequest(imaRequestData) :
          new google.ima.dai.api.VODStreamRequest(imaRequestData);
      this.streamManager_.requestStream(streamRequest);
      document.getElementById('splash').style.display = 'none';

      // For VOD Streams, update start time on media element
      if (this.startTime_ &&
          request.media.streamType ===
              cast.framework.messages.StreamType.BUFFERED) {
        this.mediaElement_.currentTime =
            this.streamManager_.streamTimeForContentTime(this.startTime_);
      }
    });
  }

  /**
   * Intercepts requests to seek and injects necessary information for snapback.
   * Also prevents seeking while ads are playing.
   * @param {!Object} seekRequest - A CAF seek request
   * @return {!Object} - A potentially modified CAF seek request
   * @private
   */
  processSeekRequest_(seekRequest) {
    const seekTo = seekRequest.currentTime;
    const previousCuepoint =
        this.streamManager_.previousCuePointForStreamTime(seekTo);
    if (this.adIsPlaying_) {
      // effectively cancels seek request
      seekRequest.currentTime = this.mediaElement_.currentTime;
    } else if (!previousCuepoint.played) {
      // Adding 0.1 to cuepoint start time because of bug where stream
      // freezes when seeking to certain times in VOD streams.
      seekRequest.currentTime = previousCuepoint.start + 0.1;
      this.seekToTimeAfterAdBreak_ = seekTo;
    }
    return seekRequest;
  }

  /**
   * Sets flags and UI at the start of an ad break.
   * @private
   */
  startAdBreak_() {
    this.adIsPlaying_ = true;
    document.getElementById('ad-ui').style.display = 'block';
    this.broadcast('adBreakStarted');
  }

  /**
   * Sets flags and UI and triggers snapback at the end of an ad break.
   * @private
   */
  endAdBreak_() {
    this.adIsPlaying_ = false;
    document.getElementById('ad-ui').style.display = 'none';
    this.broadcast('adBreakEnded');
    // process any pending snapback request
    if (this.seekToTimeAfterAdBreak_ != -1) {
      this.seek(this.seekToTimeAfterAdBreak_);
      this.seekToTimeAfterAdBreak_ = -1;
    }
  }

  /**
   * Updates ad UI to display progress in ad break.
   * @param {!Object} event - The ad progress event from IMA
   * @private
   */
  updateAdProgress_(event) {
    const adData = event.getStreamData().adProgressData;
    document.getElementById('ad-position').textContext =
        parseInt(adData.adPosition, 10);
    document.getElementById('total-ads').textContext =
        parseInt(adData.totalAds, 10);
    document.getElementById('time-value').textContext =
        Math.ceil(parseFloat(adData.duration) - parseFloat(adData.currentTime));
    document.getElementById('ad-ui').style.display = 'block';
  }

  /**
   * Seeks video playback to specified time if not playing an ad.
   * @param {number} time - The target stream time in seconds, including ads.
   */
  seek(time) {
    if (time > 0 && !this.adIsPlaying_) {
      this.mediaElement_.currentTime = time;
      this.broadcast('Seeking to: ' + time);
    }
  }

  /**
   * Sets a bookmark to a specific time on future playback.
   * @param {number} time - The target stream time in seconds, including ads.
   */
  bookmark(time) {
    this.startTime_ = time;
  }

  /**
   * Gets the current timestamp in the stream, not including ads.
   * @return {number} - The stream time in seconds, without ads.
   */
  getContentTime() {
    const currentTime = this.mediaElement_.currentTime;
    return this.streamManager_.contentTimeForStreamTime(currentTime);
  }

  /**
   * Broadcasts a message to all attached CAF senders
   * @param {string} message - The message to be sent to attached senders
   */
  broadcast(message) {
    console.log(message);
    this.castContext_.sendCustomMessage(NAMESPACE, undefined, message);
  }
}
