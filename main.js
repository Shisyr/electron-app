const {app, BrowserWindow, dialog} = require('electron');
const myip = require('quick-local-ip');
const isOnline = require('is-online');
const request = require('request');
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
          const tmpList = [];
          listUrlsToDownload.map(item => {
            if (item.downloaded) {
              tmpList.push(item);
            }
            else if (item.inProgress) {
              if (fs.existsSync(item.path + item.name)) {
                fs.unlinkSync(item.path + item.name);
              }
              item.response.abort();
              console.log(item.connection);
              console.log(item.response);
              delete item.file;
              delete item.response;
              item.inProgress = false;
              allUrlsToDownload.push(item);
            }
          })
          currentDownloadFiles -= listUrlsToDownload.length - tmpList.length;
          listUrlsToDownload = tmpList;
          console.log('HAS NO INTERNET');
        }
      })
    }, 5000)
  }
}

let isConnectedWithWeb = false;
let isAllDownloaded = false;
let isStartedDownload = false;
let limitDownloadFiles = 10;
let currentDownloadFiles = 0;
let listUrlsToDownload = [];
let lastEndFile = null;
let allUrlsToDownload = [];
let serverHost = '';
// Http server

const SOCKET_TYPES = {
  download: 'DOWNLOAD',
  connected: 'CONNECT'
}

let clients = [];

const _app = express();
const server = require('http').Server(_app);
server.listen(Config.http_port);

io = io.listen(server);

io.sockets.on('connection', (socket) => {
  clients.push(socket);
  socket.on('disconnect', () => {
    clients = clients.filter(client => client.id !== socket.id);
    socket.disconnect();
  })
  socket.on('SERVER_CLEAR_LOGS', (data) => {
    if (data.isClearAll) {
      listUrlsToDownload = listUrlsToDownload.filter(file => !file.downloaded);
      sendAll('CLIENT_CLEAR_LOGS', {type: 'CLEARED_FILES', listDownloadFiles: listUrlsToDownload})
    }
  })
  socket.on('CONNECTION_WITH_WEB', () => {
    isConnectedWithWeb = true
    const allUrls = [...listUrlsToDownload, ...allUrlsToDownload];
    sendAll('connectedWithWeb', {
      type: "CONNECTION_SUCCESSFULLY",
      listDownloadFiles: allUrls
    });
    if (isStartedDownload) {
      StartToDownload();
    }
  });
  socket.on('START_DOWNLOAD', async function (data) {
    if (data.data && data.data.length) {
      const selection = await dialog.showOpenDialog({properties: ['openDirectory']});
      if (!selection.canceled) {
        const updateData = data.data.map(file => {
          return ({...file, downloaded: false, inProgress: false, error: false, path: selection.filePaths[0] + '/'});
        })
        allUrlsToDownload = allUrlsToDownload.concat(updateData);
        runDownloading();
      }
    }
  });
  socket.on('RETRY_DOWNLOAD', async function (data) {
    if (data.data) {
      listUrlsToDownload = listUrlsToDownload.map(item => {
        if (item.id === data.data.id && item.url === data.data.url && item.name === data.data.name && item.path === data.data.path) {
          item.file = fs.createWriteStream(item.path + item.name);
          item.response = download(item.url);
          item.error = false;
        }
        return item;
      });
      isStartedDownload = true;
      StartToDownload();
    }
  })
  RunCheckConnection((data) => {
    if (data === 'RECONNECT') {
      runDownloading();
    }
  })
})

const sendAll = (eventName, message) => {
  clients.forEach(client => {
    client.emit(eventName, message);
  })
}


const fillAvailableOrders = () => {
  if (currentDownloadFiles === 0) {
    while (currentDownloadFiles <= limitDownloadFiles && allUrlsToDownload.length > 0) {
      listUrlsToDownload.push(allUrlsToDownload.pop());
      currentDownloadFiles += 1;
    }
  }
}

const download = function (uri) {
  return request(encodeURI(uri), {
      headers: {
        referer: 'http://localhost:4201'
      }
  })
};

const InitConfigToDownload = (item, index) => {
  if (item.downloaded || item.inProgress || item.response || item.file) {
    return item;
  }
  let fileNameWithPath = item.path + item.name;
  if (fs.existsSync(fileNameWithPath)) {
    fileNameWithPath = item.path + index + item.name;
    item.name = index + item.name;
  }
  item.response = download(item.url);
  item.file = fs.createWriteStream(fileNameWithPath)
  return item;
}

const PrepareToDownload = () => {
  listUrlsToDownload = listUrlsToDownload.map((item, index) => {
    return InitConfigToDownload(item, index);
  })
}
const StartToDownload = () => {
  listUrlsToDownload.forEach(async (item, index) => {
    if (!item.response || !item.file) {
      return;
    }
    item.file.on('close', () => {
      if (!item.file) {
        return;
      }
      const writtenBytes = String(item.file.bytesWritten);
      if (item.totalSize !== writtenBytes) {
        if (fs.existsSync(item.path + item.name)) {
          fs.unlink(item.path + item.name, (res) => {
            console.log('DELETE');
            console.log(res);
            console.log('DELETE');
            item.file = null;
          });
        }
        item.response = null;
        item.downloaded = false;
        item.inProgress = false;
        item.error = true;
        sendAll('downloading', {
          type: 'ERROR_FILE',
          item: {id: item.id, name: item.name, url: item.url, error: item.error, totalSize: item.totalSize, path: item.path}
        })
      } else {
        item.downloaded = true;
        item.inProgress = false;
        item.response = null;
        item.file = null;
        Axios.post(item.serverPath, {imageUrl: item.url}).then(res => {
          if (res.status === 200) {
            sendAll('downloading', {
              type: 'END_DOWNLOAD',
              item: {id: item.id, name: item.name, url: item.url, downloaded: item.downloaded, totalSize: item.totalSize, path: item.path}
            })
            console.log('CURRENT FILES: ', currentDownloadFiles);
            if (!lastEndFile || (item.id !== lastEndFile.id || item.url !== lastEndFile.url || item.name !== lastEndFile.name || item.path !== lastEndFile.path)) {
              currentDownloadFiles -= 1;
              lastEndFile = item;
            }
            if (currentDownloadFiles === 0) {
              const isContinue = currentDownloadFiles <= limitDownloadFiles && allUrlsToDownload.length > 0;
              if (isContinue) {
                runDownloading();
              }
            }
            if (!(listUrlsToDownload.some(file => !file.downloaded)) && allUrlsToDownload.length === 0) {
              isAllDownloaded = true;
              isStartedDownload = false;
            }
          } else {
            sendAll('downloading', {
              type: 'ERROR_FILE',
              item: {id: item.id, name: item.name, url: item.url, downloaded: item.downloaded, totalSize: item.totalSize, path: item.path}
            })
          }
        }).catch(e => {
          sendAll('downloading', {
            type: 'ERROR_FILE',
            item: {id: item.id, name: item.name, url: item.url, downloaded: item.downloaded, totalSize: item.totalSize, path: item.path}
          })
        })
      }
    })
    item.response.on('response', (res) => {
      if (res.statusCode === 200) {
        item.inProgress = true;
        item.totalSize = res.headers['content-length'];
        res.pipe(item.file);
        sendAll('downloading', {
          type: 'MOVE_TO_PROGRESS',
          item: {id: item.id, name: item.name, url: item.url, inProgress: item.inProgress, totalSize: item.totalSize, path: item.path}
        })
      } else if(res.statusCode === 404) {
        item.error = true;
        const {id, name, url, error, path} = item;
        sendAll('downloading', {
          type: 'NOT_FOUND',
          item: {id, name, url, error, path}
        })
      }
    })
  });
}

const runDownloading = () => {
  fillAvailableOrders();
  PrepareToDownload()
  isStartedDownload = true;
  const allFiles = [...listUrlsToDownload, ...allUrlsToDownload];
  sendAll('downloading', {
    type: 'STARTED_TO_DOWNLOAD',
    listDownloadFiles: allFiles
  })
  StartToDownload()
}

// Console print
console.log('[SERVER]: WebSocket on: ' + myip.getLocalIP4() + ':' + Config.socket_port); // print websocket ip address
console.log('[SERVER]: HTTP on: ' + myip.getLocalIP4() + ':' + Config.http_port); // print web server ip address

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 0,
    height: 0,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    useContentSize: true,
  });
  // mainWindow.loadURL('index.html')
  mainWindow.loadURL(`http://localhost:${Config.http_port}`);

  mainWindow.hide();
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


