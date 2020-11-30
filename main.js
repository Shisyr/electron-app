const {remote, app, BrowserWindow, screen, dialog, Menu, Tray, shell} = require('electron');
const express = require('express');
const bodyParser = require('body-parser');
const isOnline = require('is-online');
const fs = require('fs');
let intervalId = null;
let currentConnection = null;
const { DownloaderHelper } = require('node-downloader-helper');
const path = require('path');
let io = require('socket.io');
// Config
const Config = {
  http_port: '4201',
  socket_port: '4444'
};
let mainWindow;
let appIcon = null
const isSecondInstance = app.requestSingleInstanceLock();
console.log(!isSecondInstance);
const initializeDownload = (url, pathToSave) => {
    return new DownloaderHelper(
        encodeURI(url),
        pathToSave,
        {
            headers: {
                'Accept-Encoding': 'gzip'
            },
            removeOnFail: true,
            removeOnStop: true,
            retry: {maxRetries: 5, delay: 3000},
            httpRequestOptions: {
                timeout: (1000 * 60) * 2
            },
            httpsRequestOptions: {
                timeout: (1000 * 60) * 2
            }
        }
    );
}
if (!isSecondInstance) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Кто-то пытался запустить второй экземпляр, мы должны сфокусировать наше окно.
    console.log('SECOND TIME')
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath("exe")
  });
  const RunCheckConnection = (callback) => {
      if (!intervalId) {
          intervalId = setInterval(() => {
              isOnline().then(online => {
                  if (online) {
                      if (currentConnection === 'LOST_CONNECTION') {
                          currentConnection = 'HAS_CONNECTION'
                          callback('RECONNECT');
                      }
                  } else {
                      callback('LOST')
                      currentConnection = 'LOST_CONNECTION';
                  }
              })
          }, 3000)
      }
  }
  let isConnectedWithWeb = false;
  let isStartedDownload = false;
  let limitDownloadFiles = 10;
  let downloadedImages = 0;
  let totalImages = 0;
  let isStoppedAllRequests = false;
  let listUrlsToDownload = [];
  let listUrlsOnOrders = [];
  // Http server

  let clients = [];

  const _app = express();
  const server = require('http').Server(_app);
  server.listen(Config.http_port);

  io = io.listen(server);

  io.sockets.on('connection', (socket) => {
    clients.push(socket);
    console.log(clients.length);
    socket.on('disconnect', () => {
      clients = clients.filter(client => client.id !== socket.id);
      socket.disconnect();
    })
    socket.on('CONNECTION_WITH_WEB', () => {
      isConnectedWithWeb = true;
      sendAll('connectedWithWeb', {
        type: "CONNECTION_SUCCESSFULLY",
        totalImages,
        downloadedImages
      });
    });
    socket.on('START_DOWNLOAD', async function (data) {
      if (data.data && data.data.length) {
        const currentWindow = BrowserWindow.getAllWindows()[0];
        const selection = await dialog.showOpenDialog(
          currentWindow,
          {
          properties: ['openDirectory'],
          title: "Select path to download photos"
        });
        if (!selection.canceled) {
          if (appIcon) {
            appIcon.setImage(path.join(__dirname, 'favicon.png'));
          }
          totalImages += data.data.length;
          const updateData = data.data.map((file, index) => {
            let newPath = selection.filePaths[0] + '/';
            if (file.sceneName) {
              newPath = selection.filePaths[0] + '/' + `${file.sceneName}/`;
              if (!fs.existsSync(newPath)) {
                fs.mkdirSync(newPath);
              }
            }
            return ({...file, pathToSave: newPath});
          })
          listUrlsOnOrders = listUrlsOnOrders.concat(updateData);
          remindAboutDownloading();
          if (!isStartedDownload) {
            runDownloading();
          }
        }
      }
    });
  })

  const sendAll = (eventName, message) => {
    clients.forEach(client => {
      client.emit(eventName, message);
    })
  }

  const moveFromOrdersToDownload = () => {
      let index = 0;
      while (index < limitDownloadFiles && listUrlsOnOrders.length) {
          listUrlsToDownload.push(listUrlsOnOrders.pop());
          index += 1;
      }
      console.log(listUrlsOnOrders.length);
      console.log(listUrlsToDownload);
  };

  const startToDownload = () => {
    listUrlsToDownload = listUrlsToDownload.map(item => {
      if (!item.request && !item.downloaded) {
          item.request = initializeDownload(item.url, item.pathToSave);
          item.request.on('end', (downloadInfo) => {
              if (downloadInfo.totalSize === downloadInfo.onDiskSize) {
                  console.log('Download Completed')
                  downloadedImages += 1;
                  console.log(downloadedImages);
                  sendAll('downloading', {
                      type: 'END_DOWNLOAD',
                      downloadedImages,
                      totalImages
                  });
                  item.request.__request.destroy();
                  item.request = null;
                  item.downloaded = true;
                  delete item;
                  if (listUrlsOnOrders.length) {
                      listUrlsToDownload.push(listUrlsOnOrders.pop());
                      startToDownload();
                      console.log(listUrlsToDownload);
                  }
                  if (downloadedImages === totalImages) {
                      isStartedDownload = false;
                  }
              }
          })
          item.request.on('resume', (isResume) => {
              console.log(isResume);
          })
          item.request.start();
      }
      return item;
    });
    listUrlsToDownload = listUrlsToDownload.filter(item => item);
    RunCheckConnection((state) => {
        console.log(state);
        if (state === 'LOST' && !isStoppedAllRequests) {
            listUrlsToDownload = listUrlsToDownload.map(item => {
                const stats = ['STARTED', 'DOWNLOADING']
                if (item && item.request && stats.includes(item.request.state)) {
                    try {
                        item.request.stop();
                        item.request.__request.destroy();
                        isStoppedAllRequests = true;
                    } catch (e) {
                        console.log(e);
                    }
                }
                return item;
            });
        } else if (state === 'RECONNECT' && isStoppedAllRequests) {
            listUrlsToDownload = listUrlsToDownload.map(item => {
                const stats = ['FAILED', 'STOPPED', 'SKIPPED']
                if (item && item.request && stats.includes(item.request.state)) {
                    try {
                        item.request.start();
                        isStoppedAllRequests = false;
                    } catch (e) {
                        console.log(e);
                    }
                }
                return item;
            });
        }
    })
  }

  const runDownloading = () => {
    isStartedDownload = true;
    moveFromOrdersToDownload();
    startToDownload();
  }

  const remindAboutDownloading = () => {
    sendAll('downloading', {
      type: 'STARTED_TO_DOWNLOAD',
      totalImages,
      downloadedImages
    })
  }

  // Keep a global reference of the window object, if you don't, the window will
  // be closed automatically when the JavaScript object is garbage collected.

  function createWindow() {
    const {start_width, start_height} = screen.getPrimaryDisplay().workAreaSize;
    mainWindow = new BrowserWindow({
      width: start_width,
      height: start_height,
      show: false,
      acceptFirstMouse: true,
      autoHideMenuBar: true,
      useContentSize: true,
      focusable: true,
      alwaysOnTop: true,
      type: 'toolbar',
      webPreferences: {
        nodeIntegration: true,
        enableRemoteModule: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    mainWindow.setIcon(path.join(__dirname, 'favicon.png'))
    console.log(remote);
    // mainWindow.setAlwaysOnTop(true, 'screen-saver', 9999);
    // mainWindow.loadURL('index.html')
    mainWindow.loadURL(`http://localhost:${Config.http_port}`).then(() => {
      appIcon = new Tray(path.join(__dirname,'no-active-favicon.png'));
      const trayMenuTemplate = [
        {
          label: 'Open Web Project',
          click: function() {
            shell.openExternal('https://dev.allpix.io');
          }
        },
        {
          label: 'Exit',
          click: function () {
            app.quit();
          }
        }
      ]
      let trayMenu = Menu.buildFromTemplate(trayMenuTemplate)
      appIcon.setContextMenu(trayMenu)
    });

    // Open the DevTools.
    // mainWindow.webContents.openDevTools();
    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
      mainWindow = null
    })
  }

  app.on('ready', createWindow)

  // Quit when all windows are closed.
  app.on('window-all-closed', function () {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', function () {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
      createWindow()
    }
  })

  /**
   * EXPRESS
   */

  _app.use(bodyParser.urlencoded({
    extended: false
  }));
  _app.use(bodyParser.json())

  // _app.use('/assets', express.static(__dirname + '/www/assets'))

  _app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
  });
}
