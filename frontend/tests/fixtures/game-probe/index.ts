import {DemoController} from './demo-controller.js';
import {ProbeProfileBinding} from './profile-binding.js';

const demo = new DemoController();
const profile = new ProbeProfileBinding(user => demo.setProfile(user));
window.addEventListener('pagehide', event => {
  demo.finish();
  // A bfcache page retains its controller and committed presentation.
  if (!event.persisted) {profile.dispose(); demo.dispose();}
});
