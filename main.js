const {app, BrowserWindow, dialog, Menu, Tray, shell} = require('electron');
const myip = require('quick-local-ip');
const isOnline = require('is-online');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const Axios = require('axios');
let io = require('socket.io');

// Config
const Config = {
  http_port: '4201',
  socket_port: '4444'
};
let currentConnection = null;
let intervalId = null;
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
  if (appIcon) {
    appIcon.setImage('./favicon.png');
  }
  socket.on('disconnect', () => {
    clients = clients.filter(client => client.id !== socket.id);
    socket.disconnect();
  })
  socket.on('SERVER_CLEAR_LOGS', (data) => {
    if (data.isClearAll) {
      listUrlsToDownload = listUrlsToDownload.filter(file => file.inProgress);
      sendAll('CLIENT_CLEAR_LOGS', {type: 'CLEARED_FILES', listDownloadFiles: listUrlsToDownload})
    }
  })
  socket.on('CONNECTION_WITH_WEB', () => {
    isConnectedWithWeb = true;
    const allFiles = [];
    listUrlsToDownload.forEach(it => {
      it.forEach(it2 => {
        allFiles.push(it2);
      })
    });
    sendAll('connectedWithWeb', {
      type: "CONNECTION_SUCCESSFULLY",
      listDownloadFiles: allFiles
    });
  });
  socket.on('START_DOWNLOAD', async function (data) {
    if (data.data && data.data.length) {
      const selection = await dialog.showOpenDialog({properties: ['openDirectory']});
      if (!selection.canceled) {
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
  socket.on('RETRY_DOWNLOAD', async function ({data}) {
    if (data) {
      listUrlsToDownload = listUrlsToDownload.map((items, idx) => {
        let foundItem = null;
        let filteredItems = [];
        items.forEach(item => {
          if (item.id === data.data.id && item.url === data.data.url && item.name === data.data.name && item.path === data.data.path) {
            foundItem = item;
            index = idx;
          } else {
            filteredItems.push(item);
          }
        })
        if (foundItem) {
          foundItem.inProgress = false;
          foundItem.error = false;
          foundItem.downloaded = false;
          filteredItems.push(foundItem);
        }
        return filteredItems;
      })
      isStartedDownload = true;
      startToDownload();
    }
  })
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
    sendAll('downloading', {
      type: 'MOVE_TO_PROGRESS',
      item: {
        id: item.id,
        name: item.name,
        url: item.url,
        inProgress: item.inProgress,
        totalSize: item.totalSize,
        path: item.path
      }
    });
    download(item.url, item.fileNameWithPath).then(res => {
      item.inProgress = false;
      item.downloaded = true;
      item.totalSize = res;
      sendAll('downloading', {
        type: 'END_DOWNLOAD',
        item: {
          id: item.id,
          name: item.name,
          url: item.url,
          downloaded: item.downloaded,
          totalSize: item.totalSize,
          path: item.path
        }
      })
      const isNotFinishPart = listUrlsToDownload[index].some(item => !item.downloaded);
      if (!isNotFinishPart) {
        console.log(index);
        if (index + 1 < listUrlsToDownload.length) {
          index += 1;
          startToDownload();
        } else {
          console.log('ALL DOWNLOADED');
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
  const allFiles = [];
  listUrlsToDownload.forEach(it => {
    it.forEach(it2 => {
      allFiles.push(it2);
    })
  });
  sendAll('downloading', {
    type: 'STARTED_TO_DOWNLOAD',
    listDownloadFiles: allFiles
  })
}

// Console print
console.log('[SERVER]: WebSocket on: ' + myip.getLocalIP4() + ':' + Config.socket_port); // print websocket ip address
console.log('[SERVER]: HTTP on: ' + myip.getLocalIP4() + ':' + Config.http_port); // print web server ip address

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let appIcon = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 0,
    height: 0,
    show: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    useContentSize: true,
  });
  // mainWindow.loadURL('index.html')
  mainWindow.loadURL(`http://localhost:${Config.http_port}`).then(() => {
    appIcon = new Tray(`./no-active-favicon.png`);
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


