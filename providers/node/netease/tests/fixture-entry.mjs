// Explicit test-only subprocess; production main has no fixture/env switch.
import {runProvider} from '../main.mjs';
import {NeteaseProvider} from '../provider.mjs';
import {ProviderFault} from '../transport.mjs';
const t={
  cookie:'SYNTHETIC_TEST_ONLY',reset(){},setCookie(c){this.cookie=c;},restore(){},
  credential(){return {version:1,providerId:'netease',payload:JSON.stringify({cookie:this.cookie})};},
  async call(name,q){
    const song=id=>({id,name:'Fixture song',ar:[{name:'Fixture artist'}],al:{name:'Fixture album'},dt:120000});
    let b;
    switch(name){
      case 'login_status':b={data:{code:200,account:{id:123},profile:{nickname:'Synthetic'}}};break;
      case 'login_qr_key':b={data:{code:200,unikey:'synthetic-key'}};break;
      case 'login_qr_create':b={data:{qrimg:'data:image/png;base64,iVBORw0KGgo='}};break;
      case 'login_qr_check':b={code:803,cookie:this.cookie};break;
      case 'cloudsearch':
        if(q.keywords==='rate-limit')throw new ProviderFault('rate_limited',true,1000);
        if(q.keywords==='verify-risk')throw new ProviderFault('verification_required',true);
        b={result:{songCount:1,songs:[song(1)]}};break;
      case 'song_detail':b={songs:q.ids.split(',').map(song)};break;
      case 'likelist':b={ids:[1]};break;
      case 'playlist_detail':b={playlist:{trackIds:[{id:1}]}};break;
      case 'user_playlist':b={more:false,playlist:[{id:2,name:'Fixture playlist',creator:{userId:123},trackCount:1}]};break;
      case 'search':b={result:{playlistCount:1,playlists:[{id:2,name:'Fixture playlist',creator:{userId:456},trackCount:1}]}};break;
      case 'lyric_new':b={lrc:{lyric:'[00:01.00]Fixture lyric'}};break;
      case 'song_url_v1':b={data:[{id:1,url:'https://m801.music.126.net/FIXTURE.mp3',type:'mp3',br:320000,time:120000,expi:1200,fee:0}]};break;
      case 'logout':b={};break;
      default:throw new Error('unexpected fixture module');
    }
    return {body:{code:200,...b},cookie:[]};
  },
};
await runProvider(new NeteaseProvider(t));
