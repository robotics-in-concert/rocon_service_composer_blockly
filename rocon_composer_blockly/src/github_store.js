
var _ = require('lodash'),
  Promise = require('bluebird'),
  glob = Promise.promisify(require('glob')),
  fs = Promise.promisifyAll(require('fs')),
  os = require('os'),
  Path = require('path'),
  yaml = require('js-yaml'),
  nodegit = require('nodegit'),
  request = require('superagent'),
  Settings = require('./model').Settings,
  mkdirp = require('mkdirp');

/* options
 *
 * repo_root
 * working_repo
 * base_repo
 * working_branch
 * github_token
 * signature_name (optional)
 * signature_email (optional)
 */
var GithubStore = function(options){

  this.options = options;


  this.remoteCallbacks = {
    certificateCheck: function() { return 1; },
    credentials: function() {
      return nodegit.Cred.userpassPlaintextNew(config.github_token, "x-oauth-basic");
    }
  };

};



GithubStore.prototype.sync_repo = function(clean){
  var repo_root = this.options.repo_root;
  var that = this;
  var options = this.options

  console.log("tmp repo root", repo_root);

  var remoteCallbacks = this.remoteCallbacks;

  return nodegit.Repository.open(repo_root)
    .catch(function(e){
      var repo_url = "https://github.com/"+options.working_repo+".git";

      return nodegit.Clone(
        repo_url,
        repo_root,
        {remoteCallbacks: remoteCallbacks}).catch(function(e){
          logger.error('clone failed', e);


        })
        .then(function(repo){
          that.repo = repo;
           return nodegit.Remote.create(repo, "upstream",
                "https://github.com/"+config.service_repo_base+".git")
               .then(function(){
                 return repo;
               });
              
            })

    })
    .then(function(repo){
      return that.pull(repo, 'upstream', options.working_branch).then(function(){
        that.repo = repo;
        return repo;

      });
    });


};

GithubStore.prototype.pull = function(repo, remote, branch){
  var that = this;

  return repo.fetchAll(that.remoteCallbacks)
    .then(function(){
      return repo.getBranchCommit(remote + '/' + branch);
    })
    .then(function(commit){
      if(branch == "master"){
        return repo.mergeBranches("master", remote + "/master");
      }
      return repo.createBranch(branch, commit, 1, repo.defaultSignature(), "new branch");
    });


};

GithubStore.prototype.create_pull_request = function(branch_name, title, description){
  var opt = this.options;

  return new Promise(function(resolve, reject){
    var head = opt.working_repo.split("/")[0] + ":" + branch_name;
    var data = {title: title, head: head, base: opt.working_branch, body: description}
    logger.info('PR : ', data);
    request.post('https://api.github.com/repos/' + opt.base_repo + "/pulls")
      .set('Authorization', "token "+opt.github_token) 
      .type('json')
      .send(data)
      .end(function(e, res){
        e ? reject(e) : resolve(res);
      });

  });

};

GithubStore.prototype.push = function(ref){
  var repo = this.repo;

  var that = this;
  return nodegit.Remote.lookup(repo, 'origin')
    .then(function(origin){
      origin.setCallbacks(that.remoteCallbacks);

      logger.info("origin", origin);
      return origin.push(
        [ref+":"+ref],
        null,
        repo.defaultSignature(),
        "Push");



    })
    .catch(function(e){
      logger.error('failed to push', e);
      
    });
};


GithubStore.prototype.create_branch = function(base, branch_name){
  var that = this;
  return that.repo.getBranchCommit(base)
    .then(function(commit){
      return that.repo.createBranch(branch_name, commit);
    })

};

GithubStore.prototype.add_all_to_index = function(){

  return this.repo.openIndex()
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


GithubStore.prototype.addCommitPushPR = function(title, description){
  var that = this;
  var opts = this.options;
  var repo = that.repo;
  // var index = null;

  var new_branch_name = 'new-branch-'+(new Date().getTime());
  return that.create_branch(config.rapp_repo_branch, new_branch_name)
    .then(function(branch){

      return repo.checkoutBranch(new_branch_name).then(function(){
        that.add_all_to_index()
          .then(function(oid){
            return repo.getBranchCommit(config.rapp_repo_branch)
              .then(function(commit){
                logger.info(branch.toString());
                var author = that.repo.defaultSignature()

                return repo.createCommit(branch.name(), author, author, 
                                         "updated "+(new Date()), 
                                         oid, [commit])

              })
              .then(function(){
                return that.push(branch)
                  .then(function(){

                    return that.create_pull_request(branch.name().split("/")[2], title, description);

                  });

              });
            });

          })








        });

};

module.exports = GithubStore;
