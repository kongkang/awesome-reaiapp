import { defineApp } from '@reai/app-sdk/v1';
import { EmployeeController } from './controller';
import { EmployeeRepository } from './repository';
import { EmployeeAgent, createDemoAgentAdapter, createHostAgentAdapter } from './agent';
import { mountEmployee } from './view';
import manifest from '../app.manifest.json';
import { CHANGELOG_TEXT } from './release-notes';
import './employee.css';

export default defineApp({
  async activate(ctx) {
    const capabilities: readonly string[]=manifest.requires.hostCapabilities;
    const realAgent=capabilities.includes('agent.session@2') && capabilities.includes('cloud.model.invoke@1');
    ctx.commands.register(`${manifest.appId}.open`,async({signal})=>{
      await ctx.surfaces.open('main',{}, {signal});return {status:'ok'};
    });
    ctx.surfaces.register('main',async(surface)=>{
      try {
        const controller=new EmployeeController(new EmployeeRepository(ctx.storage.private('employee')));
        await controller.init();
        const agent=new EmployeeAgent(controller,realAgent?createHostAgentAdapter(ctx.agent):createDemoAgentAdapter());
        const view=mountEmployee(surface.root,{controller,agent,version:manifest.version,appId:manifest.appId,changelogText:CHANGELOG_TEXT,onNavigate:nav=>surface.reportNav?.(nav)});
        const applyIntent=(intent:unknown)=>{const value=intent as {type?:string;source?:string;actionId?:string;payload?:{type?:string}}|undefined;
          if(value?.type==='open-settings'||(value?.source==='host.titlebarAction'&&value.actionId==='settings'&&value.payload?.type==='open-settings'))view.showSettings();};
        applyIntent(surface.initialIntent);const stop=surface.onIntent(applyIntent);surface.ready();
        return ()=>{stop();view.dispose();agent.dispose();controller.lock();};
      } catch(error){surface.fail(error);}
    });
  },
});
