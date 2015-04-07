var  R = require('ramda'),
  _ = require('lodash'),
  Promise = require('bluebird'),
  glob = Promise.promisify(require('glob')),
  fs = Promise.promisifyAll(require('fs')),
  xml2js = Promise.promisifyAll(require('xml2js')),
  libxml = require('libxmljs'),
  os = require('os'),
  exec = Promise.promisify(require('child_process').exec),
  Path = require('path'),
  yaml = require('js-yaml'),
  nodegit = require('nodegit'),
  request = require('superagent'),
  mkdirp = require('mkdirp');
  // ServiceStore = require('./service_store');
  

var ServiceStore = function(options){
  // options
  // - ros_root
  this.options = options;
  this.repo_root = Path.join(os.tmpdir(), "service_repository");


  this.remoteCallbacks = {
    certificateCheck: function() { return 1; },
    credentials: function() {
      return nodegit.Cred.userpassPlaintextNew(process.env.ROCON_COMPOSER_BLOCKLY_GITHUB_TOKEN, "x-oauth-basic");
    }
  };

};


var _to_colon_sep = function(obj){
  return R.compose(
    R.join("\n"),
    R.map(R.join(": ")),
    R.toPairs
  )(obj);
};



ServiceStore.prototype._withRepo = function(){
  var repo_root = this.repo_root;
  var that = this;
  console.log("tmp repo root", repo_root);

  var remoteCallbacks = this.remoteCallbacks;

  return nodegit.Repository.open(repo_root)
    .catch(function(e){
      var repo_url = "https://github.com/"+process.env.ROCON_COMPOSER_BLOCKLY_SERVICE_REPO+".git";
      console.log(repo_url);

      return nodegit.Clone(
        repo_url,
        repo_root,
        {remoteCallbacks: remoteCallbacks}).catch(function(e){
          logger.error('clone failed', e);


        });

    })
    .then(function(repo){
      return repo.fetchAll(that.remoteCallbacks)
        .then(function(){
          console.log('merge master');
          return repo.mergeBranches("master", "origin/master");
        })
        .then(function(){
          return repo;
        });



    });


};

ServiceStore.prototype.allPackageInfos = function(){
  return this._withRepo()
    .then(function(repo){
      var workdir = repo.workdir();
      return glob(workdir + "/**/*.xml")
    })
    .then(function(packs){
      return Promise.resolve(packs)
        .map(function(xmlpath){
          return fs.readFileAsync(xmlpath).then(function(xml){
            return xml2js.parseStringAsync(xml, {explicitArray: false});
          })
          .then(function(item){
            item = item.package;
            item.path = xmlpath;
            return item;

          });

        })

    })
    // .then(function(re){ logger.debug(re); return re; })
    .catch(function(e){

      logger.error("failed to get packages :", e, e.stack);

    });

};


ServiceStore.prototype._createPullRequest = function(branch_name, title, description){
  logger.info('PR : ', branch_name);

  return new Promise(function(resolve, reject){
    var head = process.env.ROCON_COMPOSER_BLOCKLY_SERVICE_REPO.split("/")[0] + ":" + branch_name;
    var data = {title: title, head: head, base: 'master', body: description}
    logger.info('PR : ', data);
    request.post('https://api.github.com/repos/' + process.env.ROCON_COMPOSER_BLOCKLY_SERVICE_REPO_BASE + "/pulls")
      .set('Authorization', "token "+process.env.ROCON_COMPOSER_BLOCKLY_GITHUB_TOKEN) 
      .type('json')
      .send(data)
      .end(function(e, res){
        if(e){
          console.log("PR - E", e);

          reject(e);
        } else {
          console.log('PR - OK');

          resolve(res);
        }

      });

  });

};

ServiceStore.prototype._pushRepo = function(repo, ref){
  console.log(ref);
  console.log(ref+":"+ref);



  var that = this;
  return nodegit.Remote.lookup(repo, 'origin')
    .then(function(origin){
      origin.setCallbacks(that.remoteCallbacks);

      logger.info("origin", origin);
      return origin.push(
        [ref+":"+ref],
        null,
        repo.defaultSignature(),
        "Push to master");



    })
    .catch(function(e){
      logger.error('failed to push', e);
      
    });
};
ServiceStore.prototype._createBranch = function(repo){
  var new_branch_name = 'new-branch-'+(new Date().getTime());
  var base_commit = null;
  return repo.getBranchCommit('master')
    .then(function(commit){
      return repo.createBranch(new_branch_name, commit);
      // return repo.createBranch(new_branch_name, commit, 0, 
                               // repo.defaultSignature(), 'Created new barnch - '+new_branch_name);
    })
};


ServiceStore.prototype._addAllToIndex = function(repo){
  return repo.openIndex()
    .then(function(index){
      index.read(1)
      return index.addAll()
        .then(function(){
          index.write();
        })
        .then(function(){
          return index.writeTree();
        })
    });

};


ServiceStore.prototype._commitRepo = function(title, description){
  logger.info("commit", title, description)
  var that = this;
  // var index = null;

  return this._withRepo().then(function(repo){
      that._createBranch(repo)
        .then(function(branch){



          repo.checkoutBranch(branch).then(function(){
            that._addAllToIndex(repo)
              .then(function(oid){
                return repo.getBranchCommit('master')
                  .then(function(commit){
                    logger.info('1')
                    logger.info(branch.toString());
                    var author = nodegit.Signature.now("Eunsub Kim", "eunsub@gmail.com");

                    logger.info('3')
                    return repo.createCommit(branch.name(), author, author, 
                                             "updated "+(new Date()), 
                                             oid, [commit])

                  })
                  .then(function(){
                    logger.info('2', branch.name())
                    return that._pushRepo(repo, branch)
                      .then(function(){

                        return that._createPullRequest(branch.name().split("/")[2], title, description);

                      });

                  });
                });

              })








            });
      })

};

ServiceStore.prototype.exportToROS = function(title, description, service_meta, package_name){
  var that = this;
  return this.allPackageInfos()
    .then(function(packages){ 
      console.log(packages);

      console.log(service_meta);
      console.log(package_name);
      console.log('here');

      var pack = _.find(packages, {name: package_name});
      console.log("PACK", pack);


      var name_key = service_meta.name.replace(/\s+/g, "_").toLowerCase();
      var service_base = Path.join( Path.dirname(pack.path), "services", name_key);


      var xml = fs.readFileSync(pack.path)
      var xmlDoc = libxml.parseXmlString(xml);

      var package = xmlDoc.get('/package');

      var node = package.get('//export');
      if(!node){
        node = package.node('export');
      }

      node.node('concert_service', Path.join('services', name_key, name_key+'.service'));

      var resultXml = xmlDoc.toString(true);

      fs.writeFileSync(pack.path, resultXml);




      console.log(service_base);


      mkdirp.sync(service_base);

      console.log(name_key);


      // .parameters
      var params = R.compose(
        R.tap(console.log),
        R.fromPairs,
        R.map(R.props(['key', 'value']))
      )(service_meta.parameters);
      var param_file_content = _to_colon_sep(params);
      console.log('---------------- .interactions --------------------');
      R.forEach(function(i){
        i.parameters = R.fromPairs(R.map(R.values)(i.parameters));
      })(service_meta.interactions);


      console.log(yaml.dump(service_meta.interactions));

      console.log('---------------- .parameters --------------------');
      console.log(param_file_content);

      console.log('---------------- .launcher --------------------');
      console.log(service_meta.launcher.launcher_body);

      // .service
      var service_kv = R.pickAll("name description author priority interactions parameters".split(/\s+/), service_meta);
      service_kv.launcher_type = service_meta.launcher.launcher_type
      service_kv.launcher = name_key + ".launcher";
      // service_kv.icon = name_key + ".icon";
      service_kv.interactions = name_key + ".interactions";
      service_kv.parameters = name_key + ".parameters";
      var service_file_content = _to_colon_sep(service_kv);
      console.log('---------------- .service --------------------');
      console.log(service_file_content);


      // save icon

      return Promise.all([
        fs.writeFileAsync(service_base + "/" + name_key + ".parameters", param_file_content),
        fs.writeFileAsync(service_base + "/" + name_key + ".launcher", service_meta.launcher.launcher_body),
        fs.writeFileAsync(service_base + "/" + name_key + ".service", service_file_content),
        fs.writeFileAsync(service_base + "/" + name_key + ".interactions", yaml.dump(service_meta.interactions))
      ]);


      return Promise.resolve(true);
    })
    .then(function(ok){
      return that._commitRepo(title, description);

    })
    .catch(function(e){
      logger.error(e);

    });




};


module.exports = ServiceStore;
