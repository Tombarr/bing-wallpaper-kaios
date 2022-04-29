(function() {
  let PUBLISHER_ID = ''; // KaiAds
  let NAME = 'Bing'; // Sort
  let TEST = 0; // Test

  // From https://developer.mozilla.org/en-US/docs/Web/API/Element/toggleAttribute
  if (!Element.prototype.toggleAttribute) {
    Element.prototype.toggleAttribute = function(name, force) {
      if(force !== void 0) force = !!force
  
      if (this.hasAttribute(name)) {
        if (force) return true;
  
        this.removeAttribute(name);
        return false;
      }
      if (force === false) return false;
  
      this.setAttribute(name, "");
      return true;
    };
  }

  // @return [Headers]
  function toHeaders(headerStr) {
    const headerEntries = headerStr.split('\r\n')
      .map((h) => {
        const firstSemi = h.indexOf(':');
        return [h.substring(0, firstSemi).trim(), h.substring(firstSemi + 1).trim()];
      })
      .filter((h) => h && h[0] && h[0].length > 0 && h[1] && h[1].length > 0);
  
    const headers = new Headers();
    headerEntries.forEach(([key, value]) => {
      try {
        headers.append(key, value);
      } catch (e) {
        // TypeError "is an invalid header value" for Set-Cookie
        if (e && !e.message.indexOf('is an invalid header value')) {
          onError(e);
        }
      }
    });
  
    return headers;
  }

  // @return [Response]
  function toResponse(xhr) {
    // Assumes responseType = 'blob'
    return new Response(xhr.response, {
      status: xhr.status,
      statusText: xhr.statusText,
      headers: toHeaders(xhr.getAllResponseHeaders()),
    });
  }

  // @return [Promise<Response>] Make Fetch-like request without CORS
  function xhrFetch(url) {
    return new Promise((resolve, reject) => {
      let xhr = new XMLHttpRequest({ mozSystem: true, mozAnon: true, mozBackgroundRequest: true });
      xhr.responseType = 'blob';
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', '*/*');
      xhr.addEventListener('error', (e) =>
        reject(new Error('Network Error #' + e.target.status)));
      xhr.addEventListener('loadend', (e) => resolve(toResponse(e.target)));
      xhr.send();
    });
  }

  let snackbarTimeout = 0;
  let dimTimeout = 0;
  let hasAlarmMessage = false;

  // Show a toast message
  function showToastMessage(messageStr) {
    let snackbar = document.getElementById("snackbar");
    snackbar.innerText = messageStr;
    snackbar.classList.add('show');
    clearTimeout(snackbarTimeout);
    snackbarTimeout = setTimeout(function() {
      snackbar.classList.remove('show');
    }, 3000);
  }

  // Dim/undim the UI
  function updateDimming() {
    /*document.body.classList.remove('dim');
    clearTimeout(dimTimeout);
    dimTimeout = setTimeout(function() {
      document.body.classList.add('dim');
    }, 5000);*/
  }

  // @return [String]
  function getResolution() {
    return [
      (window.screen.width * window.devicePixelRatio), 'x',
      (window.screen.height * window.devicePixelRatio),
    ].join('');
  }

  // @return [Date]
  function getStartDate(startdate) {
    let date = new Date();
    date.setFullYear(+startdate.slice(0, 4));
    date.setMonth(+startdate.slice(4, 6) - 1);
    date.setDate(+startdate.slice(6, 8));
    return date;
  }

  // @return [Promise<Array<Object>>]
  function getBingImages(numOfImages = 1) {
    console.debug('getBingImages', numOfImages);
    let mkt = navigator.language || 'en-US';
    let res = getResolution();
    let n = Number.parseInt(Math.min(8, Math.max(1, numOfImages)), 10); // Integer between 1 - 8

    return xhrFetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=' + n + '&mkt=' + mkt)
      .then((resp) => resp.json())
      .then((bingResp) => bingResp.images.map((imgObj) => ({
        image: 'https://www.bing.com' + imgObj.urlbase + '_' + res + '.jpg',
        title: imgObj.title,
        copyright: imgObj.copyright,
        copyrightLink: imgObj.copyrightlink,
        startDate: getStartDate(imgObj.startdate),
      })));
  }

  let hasMessageHandler = (typeof navigator === 'object' && 'mozSetMessageHandler' in navigator);

  // @returns [Promise] Register ServiceWorker
  function registerServiceWorker() {
    return navigator.serviceWorker
      .register('./sw.js', { scope: '/' })
      .then((registration) => {
        console.debug('ServiceWorker Registered!');

        if (!navigator.serviceWorker.controller) {
          // The window client isn't currently controlled so it's a new service
          // worker that will activate immediately
          return Promise.resolve(true);
        }

        // Start handling messages immediately
        if ('startMessages' in navigator.serviceWorker) {
          navigator.serviceWorker.startMessages();
        }

        // Update the SW, if available
        if ('update' in registration && navigator.onLine) {
          return registration.update();
        }

        return Promise.resolve(true);
      });
  }

  // @returns [ServiceWorkerRegistration] ServiceWorkerRegistration
  function getRegistration() {
    if (typeof self === 'object' && self.registration) {
      return Promise.resolve(self.registration);
    }

    if (typeof navigator === 'object' && navigator.serviceWorker) {
      return navigator.serviceWorker.ready;
    }

    return Promise.resolve(undefined);
  }

  // @returns [Boolean|Promise]
  function setMessageHandler(name, handler) {
    if (hasMessageHandler) {
      // KaiOS 2.5
      return Promise.resolve(navigator.mozSetMessageHandler(name, handler) || true);
    } else if ('systemMessageManager' in ServiceWorkerRegistration.prototype) {
      // KaiOS 3.0
      return getRegistration()
        .then((registration) => {
          if (registration && registration.systemMessageManager) {
            return registration.systemMessageManager.subscribe(name);
          }
        })
        .catch((e) => console.warn(`Cannot subscribe to ${name} system messages.`, e));
    }

    return false;
  }

  let bingImages = [];
  let bingIndex = 0;
  let wallpaperLoaded = false;
  let dialogOpen = false;

  let wallpaper = document.getElementById('wallpaper');
  let title = document.getElementById('title');
  let copyright = document.getElementById('copyright');
  let softkeyMenu = document.getElementById('softkey-menu');
  let controls = document.getElementById('controls');
  let menuDialog = document.getElementById('menu-list');
  let noInternetDialog = document.getElementById('no-internet');
  let dailyButton = document.getElementById('button-toggle-daily');

  // Update text for daily alarm
  function updateDailyButton(alarmEnabled) {
    dailyButton.innerText = (alarmEnabled) ? '3. Disable Daily' : '3. Enable Daily';
  }

  // @returns [Boolean] True if the index has changed
  function updateBingIndex(n) {
    let originalIndex = bingIndex;
    bingIndex += n;

    if (bingIndex < 0) {
      bingIndex = 0;
    } else if (bingIndex === bingImages.length) {
      bingIndex = bingImages.length - 1;
    }

    return (originalIndex !== bingIndex);
  }

  // Update SoftKey offset
  function updateSoftKeyPosition() {
    let rect = copyright.getBoundingClientRect();
    if (rect.top) {
      softkeyMenu.style.top = Math.round(rect.top - 30) + 'px';
    } else {
      softkeyMenu.style.top = '';
    }
  }

  // Display the Bing image based on the current index
  function displayBingImage() {
    let imageObj = bingImages[bingIndex];

    if (imageObj) {
      title.innerText = imageObj.title;
      copyright.innerText = imageObj.copyright;
      requestAnimationFrame(updateSoftKeyPosition);

      wallpaperLoaded = false;
      return setImagePromise(imageObj.image)
        .then(() => { wallpaperLoaded = true; })
        .catch(() => {
          wallpaperLoaded = false;
          showToastMessage('Error Loading Wallpaper');
        });
    }

    return Promise.reject(null);
  }

  // Display the Bing gallery
  function displayBingGallery(images) {
    bingImages = images;
    return displayBingImage();
  }

  function toggleDialogVisibility() {
    menuDialog.toggleAttribute('open');
    menuDialog.toggleAttribute('hidden');
    dialogOpen = menuDialog.hasAttribute('open');
  }

  // Toggle arrow visibility
  function toggleArrowVisibility() {
    if (bingIndex === 0) {
      controls.classList.add('start');
    } else if (bingIndex === bingImages.length - 1) {
      controls.classList.add('end');
    } else {
      controls.classList.remove('start');
      controls.classList.remove('end');
    }
  }

  // Next wallpaper
  function prevWallpaper() {
    if (updateBingIndex(-1)) {
      displayBingImage()
        .then(() => toggleArrowVisibility());
    }
  }

  // Previous wallpaper
  function nextWallpaper() {
    if (updateBingIndex(1)) {
      displayBingImage()
        .then(() => toggleArrowVisibility());
    }
  }

  function onError(error) {
    console.trace();
    console.error(error.name, error.message);
    console.error(error);
  }

  // @returns [Promise] Show notification via ServiceWorker
  function showNotification(title, body, icon, tag, data) {
    console.debug('showNotification', title, body);
    return getRegistration()
      .then((registration) => registration.showNotification(title, {
        actions: [{
          action: 'open',
          title: 'Open',
        }, {
          action: 'dismiss',
          title: 'Dismiss',
        }],
        body,
        icon: icon,
        tag, tag,
        data: data || { },
        silent: true,
        requireInteraction: false,
        renotify: false,
        noscreen: true,
        mozbehavior: {
          showOnlyOnce: true,
        },
      }));
  }

  function showOfflineNotification() {
    console.debug('showOfflineNotification');
    return showNotification('No Internet', 'Cannot set wallpaper');
  }

  function showErrorNotification() {
    console.debug('showErrorNotification');
    return showNotification('Error', 'Cannot set wallpaper');
  }

  // @returns [Boolean] True if the Bing image response is valid
  const hasValidImage = (bingImages) => (
    bingImages.length &&
    bingImages[0] &&
    bingImages[0].image
  );

  // @returns [Promise] Set the wallpaper and resolve when loaded
  function setImagePromise(srcUrl) {
    return new Promise((resolve, reject) => {
      wallpaper.addEventListener('load', resolve);
      wallpaper.addEventListener('error', reject);
      wallpaper.src = srcUrl;
    });
  }

  function exit() {
    console.debug('exit');
    return Promise.resolve(setTimeout(() => window.close()));
  }

  // @return [Promise] Set wallpaper to latest from Bing
  function setLatestWallpaperAsync() {
    return getBingImages(1)
      .then((bingImages) => {
        if (!hasValidImage(bingImages)) {
          throw new Error('No wallpaper');
        }
        return xhrFetch(bingImages[0].image);
      })
      .then((resp) => resp.blob()) // Download wallpaper
      .then(setWallpaperFromBlob) // Set wallpaper
      .then(setAlarmTomorrow) // Set another alarm
      .then(exit) // Close app
      .catch((e) => {
        onError(e);
        return showErrorNotification();
      });
  }

  // Handler on Mozilla Alarm API
  function onMozAlarm(alarmObject) {
    hasAlarmMessage = true;
    console.debug('onMozAlarm', alarmObject, navigator.onLine);

    if (navigator.onLine) {
      navigator.mozSetMessageHandlerPromise(
        Promise.all([
          setLatestWallpaperAsync()
        ])
      );
    } else {
      navigator.mozSetMessageHandlerPromise(
        showOfflineNotification()
      );
    }
  }

  // @returns [Promise<Blob>] Get current wallpaper as a blob
  function getWallpaperBlob() {
    console.debug('getWallpaperBlob');
    return new Promise((resolve, reject) => {
      try {
        let canvas = document.createElement('canvas');
        canvas.width = document.body.clientWidth * window.devicePixelRatio;
        canvas.height = document.body.clientHeight * window.devicePixelRatio;
        let context = canvas.getContext("2d");
        context.drawImage(wallpaper, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, "image/jpeg");
      } catch (e) {
        onError(e);
        reject(e);
      }
    });
  }

  // @return Promise<Boolean> Set wallpaper from Blob
  function setWallpaperFromBlob(blob) {
    console.debug('setWallpaperFromBlob', blob);

    return new Promise((resolve, reject) => {
      let domRequest = navigator.mozSettings.createLock().set({
        "wallpaper.image": blob,
      });

      domRequest.onsuccess = () => {
        console.debug('Wallpaper Set');
        showToastMessage('Wallpaper Set');
        resolve(true);
      };

      domRequest.onerror = (e) => {
        console.debug('Cannot Set Wallpaper', e);
        onError(e);
        showToastMessage('Cannot Set Wallpaper');
        reject(e);
      };
    });
  }

  // Set the system wallpaper to the current image preview
  function setWallpaperFromPreview() {
    console.debug('setWallpaperFromPreview');
    return getWallpaperBlob()
      .then(setWallpaperFromBlob);
  }

  // @returns [String] Get file name for the current wallpaper
  function getFileName() {
    try {
      let url = new URL(wallpaper.src);
      return url.searchParams.get('id');
    } catch (e) {
      onError(e);
    }
  }

  // Download wallpaper to disk
  function downloadWallpaper() {
    return getWallpaperBlob()
      .then((blob) => {
        let link = document.createElement('a');
        link.style.display = 'none';
        link.setAttribute('hidden', 'true');
        link.setAttribute('href', URL.createObjectURL(blob));
        link.setAttribute('download', getFileName());
        document.body.appendChild(link);

        // Click then remove link
        requestAnimationFrame(() => {
          link.click();
          setTimeout(() => {
            link.remove();
            URL.revokeObjectURL(link.getAttribute('href'));
          }, 2000);
        });
      });
  }

  // Toggle detailed information
  function toggleInfo() {
    document.body.classList.toggle('show-info');
    requestAnimationFrame(updateSoftKeyPosition);
  }

  // KaiOS 2.5
  let hasMozAlarmApi = (
    typeof navigator !== 'undefined' &&
    'mozAlarms' in navigator
  );

  // KaiOS 3.0
  let hasAlarmManagerApi = (
    typeof navigator !== 'undefined' &&
    'b2g' in navigator &&
    'alarmManager' in navigator.b2g
  );

  // @returns [Promise] From DOMRequest
  function toPromise(domRequest) {
    return new Promise((resolve, reject) => {
      domRequest.onsuccess = (e) => resolve(e.target.result);
      domRequest.onerror = (e) => reject(e.target.error);
    });
  }

  // @returns Promise<Number|NaN|Error> Add a new alarm
  function addAlarm(date, data, ignoreTimezone) {
    if (!(date && date instanceof Date)) {
      return Promise.resolve(NaN);
    }

    if (hasAlarmManagerApi) {
      return navigator.b2g.alarmManager.add({
        date: date,
        data: data,
        ignoreTimezone: ignoreTimezone || false,
      });
    } else if (hasMozAlarmApi) {
      const respectTimezone = (ignoreTimezone) ? 'ignoreTimezone' : 'honorTimezone';
      console.debug('mozAlarms', 'add', date, respectTimezone, data);
      return toPromise(navigator.mozAlarms.add(date, respectTimezone, data));
    }

    return Promise.resolve(NaN);
  }

  // @returns Promise<Boolean> Remove an alarm with a given ID
  function removeAlarm(alarmId) {
    console.debug('removeAlarm', alarmId);
    if (hasAlarmManagerApi) {
      navigator.b2g.alarmManager.remove(alarmId);
      return Promise.resolve(true);
    } else if (hasMozAlarmApi) {
      navigator.mozAlarms.remove(alarmId);
      return Promise.resolve(true);
    }

    return Promise.resolve(false);
  }

  // @returns Promise<Array<Alarm>> Get all alarms
  function getAllAlarms() {
    if (hasAlarmManagerApi) {
      return navigator.b2g.alarmManager.getAll();
    } else if (hasMozAlarmApi) {
      return toPromise(navigator.mozAlarms.getAll());
    }

    return Promise.resolve([]);
  }

  // @returns Promise<Boolean> True if an alarm is active
  function hasAlarm() {
    return getAllAlarms()
      .then((alarms) => (alarms && alarms.length));
  }

  // @returns Promise Clear all alarms that have been set
  function clearAllAlarms(allAlarms) {
    let allMozAlarms = (allAlarms) ? allAlarms : getAllAlarms();
    console.debug('clearAllAlarms', allMozAlarms);
    return Promise.resolve(allMozAlarms)
      .then((alarms) => Promise.all(
        Array.from(alarms).map((alarm) => removeAlarm(alarm.id))
      ));
  }

  // Add an alarm for tomrrow
  function setAlarmTomorrow() {
    console.debug('setAlarmTomorrow');
    let tomorrow = new Date();
    tomorrow.setMinutes(0);
    tomorrow.setSeconds(0);
    tomorrow.setDate(new Date().getDate() + 1);
    return addAlarm(tomorrow, { timestamp: (new Date()).valueOf() }, false);
  }

  // Toggle Mozilla Alarm
  function toggleAlarm() {
    console.debug('toggleAlarm');
    return getAllAlarms()
      .then((alarms) => {
        console.debug('getAllAlarms', alarms);
        if (alarms && alarms.length) {
          // Disable Alarm
          return clearAllAlarms(alarms);
        } else {
          // Enable Alarm
          return setAlarmTomorrow();
        }
      });
  }

  // Disply a KaiAd
  function loadKaiAd() {
    if (typeof getKaiAd !== 'function') return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      return getKaiAd({
        publisher: PUBLISHER_ID,
        app: NAME,
        slot: 'main',
        test: TEST,
        onerror: (err) => reject(err),
        onready: (ad) => resolve(ad),
      });
    });
  }

  // @return [Boolean] True if the input is a number
  function isNumber(n) {
    return (
      (typeof n === 'number' || n instanceof Number) &&
      (!Number.isNaN(n) && Number.isFinite(n))
    );
  }

  wallpaper.addEventListener('error', function onImageError(e) {
    requestAnimationFrame(updateDimming);
    onError(e);
    showToastMessage('Cannot Load Image');
  });

  window.addEventListener('keydown', function onKeyDown(e) {
    console.debug('keydown', e.key, e);
    requestAnimationFrame(updateDimming);

    switch (e.key) {
      case 'ArrowLeft':
        if (!dialogOpen) {
          prevWallpaper();
        }
        break;
      case 'ArrowRight':
        if (!dialogOpen) {
          nextWallpaper();
        }
        break;
      case 'SoftLeft':
        if (!dialogOpen) {
          toggleInfo();
        }
        break;
      case 'SoftRight':
        if (wallpaperLoaded) {
          toggleDialogVisibility();
        }
        break;
      case "1":
        if (dialogOpen) {
          setWallpaperFromPreview();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case "2":
        if (dialogOpen) {
          downloadWallpaper();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case "3":
        if (dialogOpen) {
          toggleAlarm()
            .then((result) => {
              console.debug('alarm', 'toggle', result);
              if (isNumber(result)) {
                updateDailyButton(true);
                showToastMessage('Enabled');
              } else if (Array.isArray(result)) {
                updateDailyButton(false);
                showToastMessage('Disabled');
              }
            })
            .catch((e) => {
              onError(e);
              showToastMessage('Error Occurred');
            });
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case 'Backspace':
      case 'Delete':
      case 'GoBack':
        if (dialogOpen) {
          requestAnimationFrame(toggleDialogVisibility);
        } else {
          exit();
        }
        break;
      case '*':
        loadKaiAd()
          .then((ad) => (ad) ? ad.call('display') : ad)
          .catch(onError);
        break;
    }
  });

  if (!navigator.onLine) {
    // Warn No Internet
    noInternetDialog.toggleAttribute('hidden');
    noInternetDialog.toggleAttribute('open');
    document.body.classList.add('no-internet');
  } else {
    hasAlarmMessage = navigator.mozHasPendingMessage('alarm');
    console.debug('DailyPaper', 'launched', hasAlarmMessage);

    setMessageHandler('alarm', onMozAlarm);

    // Update UI outside of alarm
    if (!hasAlarmMessage) {
      // Check if alarm set
      hasAlarm()
        .then(updateDailyButton);

      // Load Bing images
      registerServiceWorker()
        .then(() => getBingImages(7))
        .then(displayBingGallery)
        .catch(onError);
    }
  }
})();
