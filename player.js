'use strict';

/**
 * Entry point for the sample video player which uses media element for
 * rendering video streams.
 *
 * @this {Player}
 * @param {!HTMLMediaElement} mediaElement for video rendering.
 */
const Player = function(mediaElement) {
  const namespace = 'urn:x-cast:com.google.ads.interactivemedia.dai.cast';
  const self = this;
  this.castPlayer_ = null;
  this.seekToTimeAfterAdBreak_ = 0;
  this.startTime_ = 0;
  this.needsCredentials_ = false;
  this.adIsPlaying_ = false;
  this.mediaElement_ = mediaElement;
  this.receiverManager_ = cast.receiver.CastReceiverManager.getInstance();
  this.receiverManager_.onSenderConnected = function(event) {
    console.log('Sender Connected');
  };
  this.receiverManager_.onSenderDisconnected =
      this.onSenderDisconnected.bind(this);
  this.imaMessageBus_ = this.receiverManager_.getCastMessageBus(namespace);
  this.imaMessageBus_.onMessage = function(event) {
    console.log('Received message from sender: ' + event.data);
    const message = event.data.split(',');
    const method = message[0];
    switch (method) {
      case 'bookmark':
        let time = parseFloat(message[1]);
        self.bookmark_(time);
        break;
      case 'seek':
        time = parseFloat(message[1]);
        self.seek_(time);
        break;
      case 'snapback':
        time = parseFloat(message[1]);
        self.snapback_(time);
        break;
      case 'getContentTime':
        const contentTime = self.getContentTime_();
        self.broadcast_('contentTime,' + contentTime);
        break;
      default:
        self.broadcast_('Message not recognized');
        break;
    }
  };

  this.mediaManager_ = new cast.receiver.MediaManager(this.mediaElement_);
  this.mediaManager_.onLoad = this.onLoad.bind(this);
  this.mediaManager_.onSeek = this.onSeek.bind(this);
  this.initStreamManager_();
};

/**
 * Initializes receiver stream manager and adds callbacks.
 * @private
 */
Player.prototype.initStreamManager_ = function() {
  const self = this;
  this.streamManager_ =
      new google.ima.dai.api.StreamManager(this.mediaElement_);
  const onStreamDataReceived = this.onStreamDataReceived.bind(this);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.LOADED,
      function(event) {
        const streamUrl = event.getStreamData().url;
        // Each element in subtitles array is an object with url and language
        // properties. Example of a subtitles array with 2 elements:
        // {
        //   "url": "http://www.sis.com/1234/subtitles_en.ttml",
        //   "language": "en"
        // }, {
        //   "url": "http://www.sis.com/1234/subtitles_fr.ttml",
        //   "language": "fr"
        // }
        self.subtitles = event.getStreamData().subtitles;
        onStreamDataReceived(streamUrl);
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.STREAM_INITIALIZED,
      function(event) {
        self.broadcast_('streamInit');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.ERROR,
      function(event) {
        const errorMessage = event.getStreamData().errorMessage;
        self.broadcast_(errorMessage);
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.CUEPOINTS_CHANGED,
      function(event) {
        console.log("Cuepoints changed: ");
        console.log(event.getStreamData());
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.STARTED,
      function(event) {
        self.broadcast_('started');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.FIRST_QUARTILE,
      function(event) {
        self.broadcast_('firstQuartile');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.MIDPOINT,
      function(event) {
        self.broadcast_('midpoint');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.THIRD_QUARTILE,
      function(event) {
        self.broadcast_('thirdQuartile');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.COMPLETE,
      function(event) {
        self.broadcast_('complete');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.AD_BREAK_STARTED,
      function(event) {
        self.adIsPlaying_ = true;
        document.getElementById('ad-ui').style.display = 'block';
        self.broadcast_('adBreakStarted');
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.AD_BREAK_ENDED,
      function(event) {
        self.adIsPlaying_ = false;
        document.getElementById('ad-ui').style.display = 'none';
        self.broadcast_('adBreakEnded');
        if (self.seekToTimeAfterAdBreak_ > 0) {
          self.seek_(self.seekToTimeAfterAdBreak_);
          self.seekToTimeAfterAdBreak_ = 0;
        }
      },
      false);
  this.streamManager_.addEventListener(
      google.ima.dai.api.StreamEvent.Type.AD_PROGRESS,
      function(event) {
        const adData = event.getStreamData().adProgressData;
        document.getElementById('ad-position').innerHTML
          = adData.adPosition;
        document.getElementById('total-ads').innerHTML
          = adData.totalAds;
        document.getElementById('time-value').innerHTML
          = Math.ceil(parseFloat(adData.duration)
            - parseFloat(adData.currentTime));
        document.getElementById('ad-ui').style.display = 'block';
      },
      false);
};


/**
 * Gets content time for the stream.
 * @returns {number} The content time.
 * @private
 */
Player.prototype.getContentTime_ = function() {
  return this.streamManager_
      .contentTimeForStreamTime(this.mediaElement_.currentTime);
};


/**
 * Sends messages to all connected sender apps.
 * @param {!string} message Message to be sent to senders.
 * @private
 */
Player.prototype.broadcast_ = function(message) {
  if (this.imaMessageBus_ && this.imaMessageBus_.broadcast) {
    this.imaMessageBus_.broadcast(message);
  }
};


/**
 * Starts receiver manager which tracks playback of the stream.
 */
Player.prototype.start = function() {
  this.receiverManager_.start();
};

/**
 * Called when a sender disconnects from the app.
 * @param {cast.receiver.CastReceiverManager.SenderDisconnectedEvent} event
 */
Player.prototype.onSenderDisconnected = function(event) {
  console.log('onSenderDisconnected');
  // When the last or only sender is connected to a receiver,
  // tapping Disconnect stops the app running on the receiver.
  if (this.receiverManager_.getSenders().length === 0 &&
      event.reason ===
          cast.receiver.system.DisconnectReason.REQUESTED_BY_SENDER) {
    this.receiverManager_.stop();
  }
};


/**
 * Called when we receive a LOAD message from the sender.
 * @param {!cast.receiver.MediaManager.Event} event The load event.
 */
Player.prototype.onLoad = function(event) {
  /*
   * imaRequest data contains:
   *   for Live requests:
   *     {
   *       assetKey: <ASSET_KEY>
   *     }
   *   for VOD requests:
   *     {
   *       contentSourceId: <CMS_ID>,
   *       videoID: <VIDEO_ID>
   *     }
   */
  const imaRequestData = event.data.media.customData;
  this.startTime_ = imaRequestData.startTime;
  this.needsCredentials_ = imaRequestData.needsCredentials;
  if (imaRequestData.assetKey) {
    this.streamRequest =
      new google.ima.dai.api.LiveStreamRequest(imaRequestData);
  } else if (imaRequestData.contentSourceId) {
    this.streamRequest =
      new google.ima.dai.api.VODStreamRequest(imaRequestData);
  }
  this.streamManager_.requestStream(this.streamRequest);
  document.getElementById('splash').style.display = 'none';
};


/**
 * Processes the SEEK event from the sender.
 * @param {!cast.receiver.MediaManager.Event} event The seek event.
 * @this {Player}
 */
Player.prototype.onSeek = function(event) {
  const currentTime = event.data.currentTime;
  this.snapback_(currentTime);
  this.mediaManager_.broadcastStatus(true, event.data.requestId);
};


/**
 * Loads stitched ads+content stream.
 * @param {!string} url of the stream.
 */
Player.prototype.onStreamDataReceived = function(url) {
  const self = this;
  const currentTime = this.startTime_ > 0 ? this.streamManager_
    .streamTimeForContentTime(this.startTime_) : 0;
  this.broadcast_('start time: ' + currentTime);

  const host = new cast.player.api.Host({
    'url': url,
    'mediaElement': this.mediaElement_
  });
  this.broadcast_('onStreamDataReceived: ' + url);

  const processMetadataCallback = function(type, data, timestamp) {
    self.streamManager_.processMetadata(type, data, timestamp);
  };
  const updateManifestRequestInfoCallback = function(requestInfo) {
    if (!requestInfo.url) {
      requestInfo.url = host.url;
    }
    if (self.needsCredentials_) {
      requestInfo.withCredentials = true;
    }
  };
  const updateLicenseRequestInfoCallback = function(requestInfo) {
    if (self.needsCredentials_) {
      requestInfo.withCredentials = true;
    }
  };
  const updateSegmentRequestInfoCallback = function(requestInfo) {
    if (self.needsCredentials_) {
      requestInfo.withCredentials = true;
    }
  };

  host.processMetadata = processMetadataCallback;
  host.updateManifestRequestInfo = updateManifestRequestInfoCallback;
  host.updateLicenseRequestInfo = updateLicenseRequestInfoCallback;
  host.updateSegmentRequestInfo = updateSegmentRequestInfoCallback;
  this.castPlayer_ = new cast.player.api.Player(host);
  this.castPlayer_.load(
    cast.player.api.CreateHlsStreamingProtocol(host), currentTime);
  if (this.subtitles[0] && this.subtitles[0].ttml) {
    this.castPlayer_.enableCaptions(true, 'ttml', this.subtitles[0].ttml);
  }
};

/**
 * Bookmarks content so stream will return to this location if revisited.
 * @private
 */
Player.prototype.bookmark_ = function() {
  this.broadcast_('Current Time: ' + this.mediaElement_.currentTime);
  const bookmarkTime = this.streamManager_
    .contentTimeForStreamTime(this.mediaElement_.currentTime);
  this.broadcast_('bookmark,' + bookmarkTime);
};

/**
 * Seeks player to location.
 * @param {number} time The time to seek to in seconds.
 * @private
 */
Player.prototype.seek_ = function(time) {
  if (this.adIsPlaying_) {
    return;
  }
  this.mediaElement_.currentTime = time;
  this.broadcast_('Seeking to: ' + time);
};

/**
 * Seeks player to location and plays last ad break if it has not been
 * seen already.
 * @param {number} time The time to seek to in seconds.
 * @private
 */
Player.prototype.snapback_ = function(time) {
  const previousCuepoint =
    this.streamManager_.previousCuePointForStreamTime(time);
  console.log(previousCuepoint);
  const played = previousCuepoint.played;
  if (played) {
    this.seek_(time);
  } else {
    // Adding 0.1 to cuepoint start time because of bug where stream freezes
    // when seeking to certain times in VOD streams.
    this.seek_(previousCuepoint.start + 0.1);
    this.seekToTimeAfterAdBreak_ = time;
  }
};
