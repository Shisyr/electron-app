const {app, BrowserWindow, dialog} = require('electron');
const myip = require('quick-local-ip');
const isOnline = require('is-online');
const request = require('request');
const requestProgress = require('request-progress');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
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
              item.status = null;
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

const MBtoByte = 1024 * 1024;
let isConnectedWithWeb = false;
let isAllDownloaded = false;
let isStartedDownload = false;
let savePath = null;
let limitDownloadFiles = 20;
let currentDownloadFiles = 0;
let listUrlsToDownload = [];
let lastEndFile = null;
let allUrlsToDownload = [];
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
  console.log('CONNECTED');
  clients.push(socket);
  socket.on('disconnect', () => {
    console.log('DISCONNECT');
    clients = clients.filter(client => client.id !== socket.id);
    socket.disconnect();
  })
  socket.on('SERVER_CLEAR_LOGS', (data) => {
    if (data.isClearAll) {
      listUrlsToDownload = listUrlsToDownload.filter(file => !file.downloaded);
      sendAll('CLIENT_CLEAR_LOGS', {type: 'CLEARED_FILES', listDownloadFiles: listUrlsToDownload})
    }
  })
  socket.on('CONNECTION_WITH_WEB', (data) => {
    if (data.type === SOCKET_TYPES.connected) {
      isConnectedWithWeb = true
      sendAll('connectedWithWeb', {
        type: "CONNECTION_SUCCESSFULLY",
        listDownloadFiles: listUrlsToDownload ? listUrlsToDownload.map(file => ({
          id: file.id,
          name: file.name,
          status: file.status,
          url: file.url,
          downloaded: file.downloaded,
          inProgress: file.inProgress
        })) : []
      });
      if (isStartedDownload) {
        StartToDownload(socket);
      }
    }
  })
  socket.on('START_DOWNLOAD', async function (data) {
    if (data.type === SOCKET_TYPES.download && data.data && data.data.length) {
      const selection = await dialog.showOpenDialog({properties: ['openDirectory']});
      if (!selection.canceled) {
        savePath = selection.filePaths[0];
        const updateData = data.data.map(file => ({...file, downloaded: false, inProgress: false, error: false, path: savePath + '/'}))
        allUrlsToDownload = allUrlsToDownload.concat(updateData);
        fillAvailableOrders();
        PrepareToDownload();
        sendAll('startedDownload', {
          type: 'STARTED_TO_DOWNLOAD',
          listDownloadFiles: listUrlsToDownload.map((file => ({
            id: file.id, name: file.name, status: file.status, url: file.url, downloaded: file.downloaded, error: file.error
          })))
        })
        isStartedDownload = true;
        StartToDownload(socket);
      }
    }
  });
  RunCheckConnection((data) => {
    if (data === 'RECONNECT') {
      fillAvailableOrders();
      PrepareToDownload();
      sendAll('startedDownload', {
        type: 'STARTED_TO_DOWNLOAD',
        listDownloadFiles: listUrlsToDownload.map((file => ({
          id: file.id, name: file.name, status: file.status, url: file.url, downloaded: file.downloaded
        })))
      })
      isStartedDownload = true;
      StartToDownload(socket);
    }
  })
})

const sendAll = (eventName, message) => {
  clients.forEach(client => {
    client.emit(eventName, message);
  })
}


const fillAvailableOrders = () => {
  while (currentDownloadFiles <= limitDownloadFiles && allUrlsToDownload.length > 0) {
    listUrlsToDownload.push(allUrlsToDownload.pop());
    currentDownloadFiles += 1;
  }
}

const download = function (uri) {
  return requestProgress(request(encodeURI(uri), {
      headers: {
        referer: 'http://localhost:4201'
      }
  }))
};

const InitConfigToDownload = (item, index) => {
  if (item.downloaded || item.inProgress || item.response || item.file) {
    return item;
  }
  item.response = download(item.url);
  let fileNameWithPath = item.path + item.name;
  if (fs.existsSync(fileNameWithPath)) {
    fileNameWithPath = item.path + index + item.name;
    item.name = index + item.name;
  }
  item.file = fs.createWriteStream(fileNameWithPath)
  return item;
}

const PrepareToDownload = () => {
  listUrlsToDownload = listUrlsToDownload.map((item, index) => {
    return InitConfigToDownload(item, index);
  })
}
const StartToDownload = (socket) => {
  listUrlsToDownload.forEach(async (item, index) => {
    if (!item.response || !item.file) {
      return;
    }
    item.file.on('close', () => {
      if (!item.file) {
        return;
      }
      if (item.status.totalSize !== item.file.bytesWritten) {
        if (fs.existsSync(item.path + item.name)) {
          fs.unlink(item.path + item.name, (res) => {
            console.log(res);
            item.file = null;
          });
        }
        item.response = null;
        item.downloaded = false;
        item.inProgress = false;
        sendAll('startedDownload', {
          type: 'ERROR_FILE',
          item: {
            id: item.id,
            name: item.name,
            status: item.status,
            url: item.url,
            inProgress: item.inProgress,
            error: true
          }
        })
      } else {
        item.downloaded = true;
        item.inProgress = false;
        item.response = null;
        item.file = null;
        sendAll('startedDownload', {
          type: 'END_DOWNLOAD',
          item: {
            id: item.id,
            name: item.name,
            status: item.status,
            url: item.url,
            inProgress: item.inProgress
          }
        })
        if (!lastEndFile || (item.id !== lastEndFile.id || item.url !== lastEndFile.url || item.name !== lastEndFile.name)) {
          currentDownloadFiles -= 1;
          lastEndFile = item;
        }
        if (currentDownloadFiles === 0) {
          const isContinue = currentDownloadFiles <= limitDownloadFiles && allUrlsToDownload.length > 0;
          if (isContinue) {
            fillAvailableOrders();
            PrepareToDownload()
            isStartedDownload = true;
            sendAll('startedDownload', {
              type: 'STARTED_TO_DOWNLOAD',
              listDownloadFiles: listUrlsToDownload.map((file => ({
                id: file.id, name: file.name, status: file.status, url: file.url, downloaded: file.downloaded, inProgress: file.inProgress
              })))
            })
            StartToDownload(socket)
          }
        }
        if (!(listUrlsToDownload.some(file => !file.downloaded)) && allUrlsToDownload.length === 0) {
          isAllDownloaded = true;
          isStartedDownload = false;
        }
      }
    })
    item.response.on('response', (res) => {
      if (res.statusCode === 200) {
        res.pipe(item.file);
      } else if(res.statusCode === 404) {
        sendAll('startedDownload', {
          type: 'NOT_FOUND',
          item: {
            id: item.id,
            name: item.name,
            status: item.status,
            url: item.url,
            inProgress: item.inProgress,
            error: true
          }
        })
      }
    })
    item.response.on('progress', (state) => {
      item.status = {
        speed: state.speed ? (state.speed / MBtoByte).toFixed(1) : 0,
        percent: (state.percent * 100),
        totalSize: state.size.total,
        downloadedSize: state.size.transferred ? (state.size.transferred / MBtoByte).toFixed(1) : 0,
        remainingTime: state.time.remaining ? state.time.remaining.toFixed(1) : 0,
      };
      item.inProgress = true;
      sendAll('startedDownload', {
        type: 'PROGRESS_DOWNLOAD',
        item: {
          id: item.id,
          name: item.name,
          status: item.status,
          url: item.url,
          inProgress: item.inProgress
        }
      })
    })
  });
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

_app.use('/assets', express.static(__dirname + '/www/assets'))

_app.get('/', function (req, res) {
  res.sendFile(__dirname + '/index.html');
});


