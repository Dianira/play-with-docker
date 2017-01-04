(function() {
    'use strict';

    var app = angular.module('DockerPlay', ['ngMaterial']);

    // Automatically redirects user to a new session when bypassing captcha.
    // Controller keeps code/logic separate from the HTML
    app.controller("BypassController", ['$scope', '$log', '$http', '$location', '$timeout', function($scope, $log, $http, $location, $timeout) {
        setTimeout(function() {
            var el = document.querySelector("#submit");
            el.click();
        }, 500);
    }]);

    app.controller('PlayController', ['$scope', '$log', '$http', '$location', '$timeout', '$mdDialog', '$window', function($scope, $log, $http, $location, $timeout, $mdDialog, $window) {
        $scope.sessionId = window.location.pathname.replace('/p/', '');
        $scope.instances = [];
        $scope.idx = {};
        $scope.selectedInstance = null;
        $scope.isAlive = true;
        $scope.ttl = '--:--:--';
        $scope.connected = true;
        $scope.isInstanceBeingCreated = false;
        $scope.newInstanceBtnText = '+ Add new instance';
        $scope.deleteInstanceBtnText = 'Delete';
        $scope.isInstanceBeingDeleted = false;

        angular.element($window).bind('resize', function() {
            if ($scope.selectedInstance) {
                $scope.resize($scope.selectedInstance.term.proposeGeometry());
            }
        });


        $scope.showAlert = function(title, content, parent) {
            $mdDialog.show(
                $mdDialog.alert()
                    .parent(angular.element(document.querySelector(parent || '#popupContainer')))
                    .clickOutsideToClose(true)
                    .title(title)
                    .textContent(content)
                    .ok('Got it!')
            );
        }

        $scope.resize = function(geometry) {
            $scope.socket.emit('viewport resize', geometry.cols, geometry.rows);
        }

        $scope.closeSession = function() {
            $scope.socket.emit('session close');
        }

        $scope.upsertInstance = function(info) {
            var i = info;
            if (!$scope.idx[i.name]) {
                $scope.instances.push(i);
                i.buffer = '';
                $scope.idx[i.name] = i;
            } else {
                $scope.idx[i.name].ip = i.ip;
                $scope.idx[i.name].hostname = i.hostname;
            }

            return $scope.idx[i.name];
        }

        $scope.newInstance = function() {
            updateNewInstanceBtnState(true);
            $http({
                method: 'POST',
                url: '/sessions/' + $scope.sessionId + '/instances',
            }).then(function(response) {
                var i = $scope.upsertInstance(response.data);
                $scope.showInstance(i);
            }, function(response) {
                if (response.status == 409) {
                    $scope.showAlert('Max instances reached', 'Maximum number of instances reached')
                }
            }).finally(function() {
                updateNewInstanceBtnState(false);
            });
        }

        $scope.getSession = function(sessionId) {
            $http({
                method: 'GET',
                url: '/sessions/' + $scope.sessionId,
            }).then(function(response) {
                if (response.data.created_at) {
                    $scope.expiresAt = moment(response.data.expires_at);
                    setInterval(function() {
                        $scope.ttl = moment.utc($scope.expiresAt.diff(moment())).format('HH:mm:ss');
                        $scope.$apply();
                    }, 1000);
                }
                var socket = io({ path: '/sessions/' + sessionId + '/ws' });

                socket.on('terminal out', function(name, data) {
                    var instance = $scope.idx[name];

                    if (!instance) {
                        // instance is new and was created from another client, we should add it
                        $scope.upsertInstance({ name: name });
                        instance = $scope.idx[name];
                    }
                    if (!instance.term) {
                        instance.buffer += data;
                    } else {
                        instance.term.write(data);
                    }
                });

                socket.on('session end', function() {
                    $scope.showAlert('Session timed out!', 'Your session has expired and all of your instances have been deleted.', '#sessionEnd')
                    $scope.isAlive = false;
                });

                socket.on('viewport', function(rows, cols) {
                });

                socket.on('new instance', function(name, ip, hostname) {
                    $scope.upsertInstance({ name: name, ip: ip, hostname: hostname });
                    $scope.$apply(function() {
                        if ($scope.instances.length == 1) {
                            $scope.showInstance($scope.instances[0]);
                        }
                    });
                });

                socket.on('delete instance', function(name) {
                    $scope.removeInstance(name);
                    $scope.$apply();
                });

                socket.on('viewport resize', function(cols, rows) {
                    // viewport has changed, we need to resize all terminals

                    $scope.instances.forEach(function(instance) {
                        instance.term.resize(cols, rows);
                    });
                });

                socket.on('connect_error', function() {
                    $scope.connected = false;
                });
                socket.on('connect', function() {
                    $scope.connected = true;
                });

                socket.on('instance stats', function(name, mem, cpu, isManager, ports) {
                    $scope.idx[name].mem = mem;
                    $scope.idx[name].cpu = cpu;
                    $scope.idx[name].isManager = isManager;
                    $scope.idx[name].ports = ports;
                    $scope.$apply();
                });

                $scope.socket = socket;

                var i = response.data;
                for (var k in i.instances) {
                    var instance = i.instances[k];
                    $scope.instances.push(instance);
                    $scope.idx[instance.name] = instance;
                }

                // If instance is passed in URL, select it
                let inst = $scope.idx[$location.hash()];
                if (inst) $scope.showInstance(inst);
            }, function(response) {
                if (response.status == 404) {
                    document.write('session not found');
                    return
                }
            });
        }

        $scope.getProxyUrl = function(instance, port) {
            var url = window.location.protocol + '//ip' + instance.ip.replace(/\./g, '_') + '-' + port + '.' + window.location.host;

            return url;
        }

        $scope.showInstance = function(instance) {
            $scope.selectedInstance = instance;
            $location.hash(instance.name);
            if (!instance.creatingTerminal) {
                if (!instance.term) {
                    $timeout(function() {
                        createTerminal(instance);
                        instance.term.focus();
                    }, 0, false);
                    return
                }
            }
            $timeout(function() {
                instance.term.focus();
            }, 0, false);
        }

        $scope.removeInstance = function(name) {
            if ($scope.idx[name]) {
                delete $scope.idx[name];
                $scope.instances = $scope.instances.filter(function(i) {
                    return i.name != name;
                });
                if ($scope.instances.length) {
                    $scope.showInstance($scope.instances[0]);
                }
            }
        }

        $scope.deleteInstance = function(instance) {
            updateDeleteInstanceBtnState(true);
            $http({
                method: 'DELETE',
                url: '/sessions/' + $scope.sessionId + '/instances/' + instance.name,
            }).then(function(response) {
                $scope.removeInstance(instance.name);
            }, function(response) {
                console.log('error', response);
            }).finally(function() {
                updateDeleteInstanceBtnState(false);
            });
        }

        $scope.getSession($scope.sessionId);

        function createTerminal(instance, cb) {
            if (instance.term) {
                return instance.term;
            }

            var terminalContainer = document.getElementById('terminal-' + instance.name);

            var term = new Terminal({
                cursorBlink: false
            });

            term.attachCustomKeydownHandler(function(e) {
                // Ctrl + Alt + C
                if (e.ctrlKey && e.altKey && (e.keyCode == 67)) {
                    document.execCommand('copy');
                    return false;
                }
            });

            term.open(terminalContainer);

            // Set geometry during the next tick, to avoid race conditions.
            setTimeout(function() {
                $scope.resize(term.proposeGeometry());
            }, 4);

            term.on('data', function(d) {
                $scope.socket.emit('terminal in', instance.name, d);
            });

            instance.term = term;

            if (instance.buffer) {
                term.write(instance.buffer);
                instance.buffer = '';
            }

            if (cb) {
                cb();
            }
        }

        function updateNewInstanceBtnState(isInstanceBeingCreated) {
            if (isInstanceBeingCreated === true) {
                $scope.newInstanceBtnText = '+ Creating...';
                $scope.isInstanceBeingCreated = true;
            } else {
                $scope.newInstanceBtnText = '+ Add new instance';
                $scope.isInstanceBeingCreated = false;
            }
        }

        function updateDeleteInstanceBtnState(isInstanceBeingDeleted) {
            if (isInstanceBeingDeleted === true) {
                $scope.deleteInstanceBtnText = 'Deleting...';
                $scope.isInstanceBeingDeleted = true;
            } else {
                $scope.deleteInstanceBtnText = 'Delete';
                $scope.isInstanceBeingDeleted = false;
            }
        }
    }])
    .config(['$mdIconProvider', '$locationProvider', function($mdIconProvider, $locationProvider) {
        $locationProvider.html5Mode({enabled: true, requireBase: false});
        $mdIconProvider.defaultIconSet('../assets/social-icons.svg', 24);
    }]);
})();
