// 录制只归属一个设置窗口；失焦、关闭或渲染进程退出都释放暂停状态。
class ShortcutRecording {
 constructor({suspend,resume,now=Date.now}){this.suspend=suspend;this.resume=resume;this.now=now;this.owner=null;this.listeners=[];this.doubleTapAfter=0;}
 get active(){return this.owner!==null;}
 start(window){if(!window||window.isDestroyed())throw Error('设置窗口已关闭');if(this.owner===window)return true;this.clearListeners();this.owner=window;this.doubleTapAfter=Infinity;this.suspend();const release=()=>this.stop(window);for(const event of['blur','close','closed']){window.on(event,release);this.listeners.push([window,event,release]);}for(const event of['destroyed','render-process-gone']){window.webContents.on(event,release);this.listeners.push([window.webContents,event,release]);}return true;}
 stop(window){if(!this.active||window&&window!==this.owner)return false;this.clearListeners();this.owner=null;this.doubleTapAfter=this.now()+400;this.resume();return true;}
 clearListeners(){for(const [target,event,listener]of this.listeners)target.removeListener(event,listener);this.listeners=[];}
 allowsDoubleTap(){return !this.active&&this.now()>=this.doubleTapAfter;}
}
module.exports={ShortcutRecording};
