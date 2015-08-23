'use strict';
var config = require('config');
var Promise = require('bluebird');
var mongoClient = Promise.promisifyAll(require('mongodb').MongoClient);
var Q = require('q');
var moment = require('moment');
var _ = require('lodash');
var path = require('path');


var mongoIndex = function (str) {
  return str.replace(/\./g, '');
};

var fileController = {
  createNewFileOrFolder: function (req, res) {
    var projectName = req.body.projectName || req.param('projectName');
    var type = req.body.type || req.param('type');
    var projectId = req.body.projectId || req.param('projectId') || null;
    var filePath = req.body.filePath || req.param('filePath') || '';
    var fileInfo = {
      projectName: projectName,
      filePath: filePath,
      type: type,
      projectId: projectId,
    };
    if (type !== 'file' && type !== 'folder') {
      return res.status(400).send('Invalid File Type Specified').end();
    }
    fileController._createNewFileOrFolder(fileInfo)
      .then(function (updatedFileStructure) {
        return fileController._updateFileStructure(updatedFileStructure);
      })
      .then(function (fileStructure) {
        return res.status(201).json(fileStructure);
      })
      .catch(function (err) {
        console.log('Error Creating File or Folder:', err);
        return res.status(400).end();
      });
  },
  /**
   * Create a new file or folder and append it to the project fileStructure
   * Optionally, you can pass a fileStructure to append it to. This is intended
   * for operations in which multiple files will be written to the MongoDB.
   *
   * @param <Object> Object with all file info
   * @param <Object> (Optional) fileStructure to append changes to
   * @return <Object> fileStructure
   */
  _createNewFileOrFolder: function (fileInfo, updatefileStructure) {
    var projectName = fileInfo.projectName;
    var type = fileInfo.type;
    var projectId = fileInfo.projectId || null;
    var filePath = fileInfo.filePath;
    var userId = fileInfo.userId || null;
    return new Q()
      .then(function () {
        // Check if name is valid (no white space)
        if (!fileController._isValidFileName(filePath)) {
          throw new Error('Invalid File Name');
        }
      })
      .then(function () {
        if (updatefileStructure !== undefined) {
          return updatefileStructure;
        }
        return fileController.getFileStructure(projectId || projectName);
      })
      .catch(function () {
        console.log('Error Getting File Structure');
      })
      .then(function (fileStructure) {
        // Check if path exists
        if (!fileController._isPathValidAndFileDoesNotExistAtPath(fileStructure, filePath)) {
          throw new Error('Path is Invalid or File Already Exists');
        }
        // Create Object with author, timeCreated
        var newAddition = {
          name: path.basename(filePath),
          created: moment().format(config.get('timeFormat')),
          author: userId,
          type: type,
          path: filePath
        };
        if (type === 'folder') {
          newAddition.files = {};
        }
        return fileController._appendToFileStructure(fileStructure, filePath, newAddition);
      });
  },
  /**
   * Updated fileStructure in Mongo Database
   *
   * @param <Object> fileStructure
   * @return <Promise>
   */
  _updateFileStructure: function (fileStructure) {
    return mongoClient.connectAsync(config.get('mongo'))
      .then(function (db) {
        return Promise.promisifyAll(db.collection('project_file_structre'));
      })
      .then(function (projectCollection) {
        return projectCollection.updateAsync({
            _id: fileStructure._id
          }, {
            $set: {
              files: fileStructure.files
            }
          }, {
            w: 1
          })
          .then(function () {
            return projectCollection.findOneAsync({
                _id: fileStructure._id
              })
              .then(function (fileStructure) {
                return fileStructure;
              })
              .catch(function (err) {
                console.log('Cannot Find Collection With ID', err);
              });
          });
      });
  },
  _isValidFileName: function (filePath) {
    var fileName = path.basename(filePath);
    return !(/\s/g.test(fileName) || /\//g.test(fileName));
  },
  _appendToFileStructure: function (fileStructure, filePath, newAddition) {
    var fileDirname = path.dirname(filePath);
    var fileName = path.basename(filePath);
    if (fileDirname === '.') fileDirname = '';
    if (!fileController._isFileInFileStructre(fileStructure, filePath)) {
      var subFileStructure = fileController._getSubFileStructure(fileStructure, fileDirname);
      subFileStructure.files[mongoIndex(fileName)] = newAddition;
    }
    return fileStructure;
  },
  _getSubFileStructure: function (fileStructure, filePath) {
    var _filePath = filePath.split('/').filter(function (str) {
      return str.length > 0;
    });
    var traverseFileStructure = function (_fileStructure, filePathStructure) {
      if (filePathStructure.length === 0) {
        return _fileStructure;
      }
      if (_fileStructure.files[mongoIndex(filePathStructure[0])]) {
        var subFileStructure = _fileStructure.files[mongoIndex(filePathStructure[0])];
        return traverseFileStructure(subFileStructure, filePathStructure.splice(1));
      }
      return false;
    };
    return traverseFileStructure(fileStructure, _filePath);
  },
  /**
   * Check if a given path if valid within a fileStructure
   *
   * @param <Object> fileStructure queried from mongoDB
   * @param <String> path to be queried in fileStructure
   * @param <String> name of file
   * @return <Boolean>
   */
  _isPathValidAndFileDoesNotExistAtPath: function (fileStructure, filePath) {
    var fileDirname = path.dirname(filePath);
    if (fileDirname === '') return !fileController._isFileInFileStructre(fileStructure, filePath);
    if (fileDirname === '.') return !fileController._isFileInFileStructre(fileStructure, filePath);
    return !fileController._isFileInFileStructre(fileStructure, filePath);
  },
  /**
   * Returns if file is in the root of the fileStructure
   *
   * @param <Object> (fileStructure)
   * @return <Boolean>
   */
  _isFileInFileStructre: function (fileStructure, filePath) {
    var fileName = path.basename(filePath);
    var fileDirname = path.dirname(filePath);
    var subFileStructure = fileStructure;
    if (fileDirname !== '.') {
      subFileStructure = fileController._getSubFileStructure(fileStructure, fileDirname);
    }
    return _.any(subFileStructure.files, function (file) {
      return file.name === fileName;
    });
  },
  get: function (req, res) {
    var projectName = req.body.projectName;
    return fileController.getFileStructure(projectName)
      .then(function (fileStructure) {
        return res.json(fileStructure);
      });
  },
  getFileStructure: function (projectIdOrName) {
    return new Q().then(function () {
        return getProject(projectIdOrName);
      })
      .then(function (project) {
        // Get project structure form mongo
        return mongoClient.connectAsync(config.get('mongo'))
          .then(function (db) {
            var projectCollection = Promise.promisifyAll(db.collection('project_file_structre'));
            return projectCollection.findOneAsync({
                projectId: project.get('id')
              })
              .then(function (projectFileStructure) {
                // Create empty project if nothing is found
                if (projectFileStructure === null) {
                  return projectCollection.insertAsync({
                      projectId: project.get('id'),
                      files: {}
                    })
                    .then(function (projectFileStructure) {
                      return projectFileStructure[0];
                    });
                }
                return projectFileStructure;
              })
              .then(function (projectFileStructure) {
                db.close();
                projectFileStructure.paths = fileController.getPathsForFileStructure(projectFileStructure);
                return projectFileStructure;
              });
          })
          .catch(function (error) {
            console.log('Error Connecting to MongoDB', error);
          });
      });
  },
  getPathsForFileStructure: function (fileStructure, isFilesAttribute) {
    isFilesAttribute = isFilesAttribute || false;
    var filePaths = [];
    var getPaths = function (_fileStructure) {
      _.each(_fileStructure, function (fileOrFolder) {
        filePaths.push(fileOrFolder.path);
        if (fileOrFolder.type === 'folder') {
          getPaths(fileOrFolder.files);
        }
      });
    };
    if (!isFilesAttribute) getPaths(fileStructure.files); // default
    if (isFilesAttribute) getPaths(fileStructure);

    return filePaths;
  },

  

  saveFileStructureAndCheckIfPathIsValid: function () {

  },

};


module.exports = fileController;