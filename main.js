const {remote, app, BrowserWindow, screen, dialog, Menu, Tray, shell} = require('electron');
const myip = require('quick-local-ip');
const isOnline = require('is-online');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const Axios = require('axios');
const path = require('path');
let io = require('socket.io');
// Config
const Config = {
  http_port: '4201',
  socket_port: '4444'
};
let currentConnection = null;
let intervalId = null;
let mainWindow;
let appIcon = null
const isSecondInstance = app.requestSingleInstanceLock();
console.log(!isSecondInstance);
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
            currentConnection = 'LOST_CONNECTION';
            listUrlsToDownload[index] = listUrlsToDownload[index].map(item => {
              console.log(item);
              if (!item.downloaded && item.inProgress) {
                fs.unlinkSync(item.fileNameWithPath);
                item.inProgress = false;
              }
              return item;
            });
            console.log('HAS NO INTERNET');
          }
        })
      }, 3000)
    }
  }

  let isConnectedWithWeb = false;
  let isAllDownloaded = false;
  let isStartedDownload = false;
  let limitDownloadFiles = 20;
  let downloadedImages = 0;
  let totalImages = 0;
  let listUrlsToDownload = [];
  let allUrlsToDownload = [];
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
            return ({...file, downloaded: false, inProgress: false, error: false, path: newPath});
          })
          allUrlsToDownload = allUrlsToDownload.concat(updateData);
          fillAvailableOrders();
          prepareToDownload();
          remindAboutDownloading();
          if (!isStartedDownload) {
            runDownloading();
          }
        }
      }
    });
    RunCheckConnection((data) => {
      console.log(data);
      if (data === 'RECONNECT') {
        startToDownload();
      }
    })
  })

  const sendAll = (eventName, message) => {
    clients.forEach(client => {
      client.emit(eventName, message);
    })
  }


  const fillAvailableOrders = () => {
    const numberFlows = Math.ceil(allUrlsToDownload.length / limitDownloadFiles)
    console.log('Number of flows: ', numberFlows);
    const beginIndex = listUrlsToDownload.length;
    for (let index = beginIndex;index < numberFlows + beginIndex;index++) {
      if (!listUrlsToDownload[index]) {
        console.log('Index: ', index);
        let beginIndex = 0;
        listUrlsToDownload[index] = [];
        while (beginIndex < limitDownloadFiles && allUrlsToDownload.length > 0) {
          listUrlsToDownload[index].push(allUrlsToDownload.pop());
          beginIndex++;
        }
      }
    }
  }

  const download = function (uri, pathname) {
    return new Promise((resolve, reject) => {
      const write = fs.createWriteStream(pathname);
      Axios.get(encodeURI(uri), {
        headers: {
          referer: 'http://localhost:4201'
        },
        responseType: 'stream',
        timeout: 10000 * 6000
      }).then(res => {
        res.data.pipe(write);
      }).catch(err => {
        console.log(err);
        reject(err);
      });
      write.on('close', () => {
        console.log(write.finished);
        console.log(write.writableFinished);
        resolve(write.bytesWritten)
      })
    })
  };

  const InitConfigToDownload = (item, index) => {
    item.fileNameWithPath = item.path + item.name;
    if (fs.existsSync(item.path + item.name)) {
      item.fileNameWithPath = item.path + index + item.name;
      item.name = index + item.name;
    }
    return item
  }

  const prepareToDownload = () => {
    listUrlsToDownload = listUrlsToDownload.map((item) => {
      return item.map((it, index) => {
        return InitConfigToDownload(it, index);
      })
    })
  }

  let index = 0;
  const startToDownload = () => {
    return listUrlsToDownload[index].map(item => {
      if (item.downloaded || item.inProgress) {
        return item;
      }
      item.inProgress = true;
      item.downloaded = false;
      console.log('START');
      download(item.url, item.fileNameWithPath).then(res => {
        item.inProgress = false;
        item.downloaded = true;
        item.totalSize = res;
        downloadedImages += 1;
        console.log(downloadedImages);
        sendAll('downloading', {
          type: 'END_DOWNLOAD',
          downloadedImages,
          totalImages
        });
        const isNotFinishPart = listUrlsToDownload[index].some(item => !item.downloaded);
        if (!isNotFinishPart) {
          console.log(index);
          if (index + 1 < listUrlsToDownload.length) {
            index += 1;
            startToDownload();
          } else {
            console.log('ALL DOWNLOADED');
            if (appIcon) {
              appIcon.setImage(path.join(__dirname, 'no-active-favicon.png'));
            }
            listUrlsToDownload = [];
            totalImages = 0;
            downloadedImages = 0;
            isAllDownloaded = true;
            isStartedDownload = false;
            index = 0;
          }
        }
      }).catch(err => {
        console.log('ERROR ', err);
        item.inProgress = false;
        item.downloaded = false;
        item.status = err.statusCode;
        if (item.fileNameWithPath) {
          fs.unlink(item.fileNameWithPath, (error, res) => {
            sendAll('downloading', {
              type: 'ERROR_FILE',
              item: {
                id: item.id,
                name: item.name,
                url: item.url,
                error: item.error,
                totalSize: item.totalSize,
                path: item.path,
                status: err.statusCode
              }
            })
          });
        }
      });
      return item;
    });
  }

  const runDownloading = () => {
    isStartedDownload = true;
    startToDownload();
  }

  const remindAboutDownloading = () => {
    sendAll('downloading', {
      type: 'STARTED_TO_DOWNLOAD',
      totalImages,
      downloadedImages
    })
  }

  // Console print
  console.log('[SERVER]: WebSocket on: ' + myip.getLocalIP4() + ':' + Config.socket_port); // print websocket ip address
  console.log('[SERVER]: HTTP on: ' + myip.getLocalIP4() + ':' + Config.http_port); // print web server ip address

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
          label: 'Settings',
          click: function () {
            console.log("Clicked on settings")
          }
        },
        {
          label: 'Help',
          click: function () {
            console.log("Clicked on Help")
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
