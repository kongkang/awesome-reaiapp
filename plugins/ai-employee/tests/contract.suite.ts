import { defineContractSuite } from '@reai/app-test/v1';
import manifest from '../app.manifest.json';
export default defineContractSuite({
  appDirectory:'..',hostApi:'1.24.0',
  expect:{surfaces:['main'],commands:[`${manifest.appId}.open`],intents:['open-settings'],readySurfaces:['main'],forbiddenNetworkRequests:'all',storageNamespace:manifest.appId,noResourcesAfterUnmount:true},
  scenarios:[{
    name:'Command opens the workbench and settings stay reachable',
    async run({host,expect}){
      await host.invokeCommand(`${manifest.appId}.open`);
      const main=await host.openSurface('main');expect(main).toBeOpen();
      if(!main.root)throw new Error('测试环境缺少 DOM');
      await host.sendIntent(main.surfaceMountId,{source:'host.titlebarAction',actionId:'settings',deliveryId:'employee-settings-test',payload:{type:'open-settings'}});
      if(!main.root.textContent?.includes('关于插件'))throw new Error('设置缺少关于入口');
      if(!main.root.textContent?.includes(manifest.version))throw new Error('设置版本与安装包不同');
    },
  }],
});
