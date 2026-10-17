import { expect, test } from "@playwright/test";

for (const {width,hasTouch} of [{width:390,hasTouch:true},{width:1280,hasTouch:false},{width:2560,hasTouch:false}]) {
  test.describe(`spacing at ${width}px`, () => {
    test.use({hasTouch});
    for (const theme of ["Light", "Dark"]) {
      test(`${theme.toLowerCase()} surfaces and navigation`, async ({page},testInfo) => {
        await page.setViewportSize({width,height:900});
        await page.goto('/tests/fixtures/spacing-presets/index.html');
        await page.getByRole('radiogroup',{name:'Preview theme'}).getByText(theme,{exact:true}).click();
        await expect(page.getByRole('radiogroup',{name:'Preview theme'}).getByRole('radio',{name:theme,exact:true})).toBeChecked();
        await expect(page.getByRole('heading',{name:'Workspace controls',exact:true})).toBeVisible();
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('page.png')});
        const quick=page.getByRole('button',{name:'Quick menu',exact:true});
        await quick.click();
        const menu=page.getByTestId('spacing-menu');
        await expect(menu).toBeVisible();
        await menu.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
        const menuBox=(await menu.boundingBox())!;
        expect(menuBox.x).toBeGreaterThanOrEqual(8);
        expect(menuBox.x+menuBox.width).toBeLessThanOrEqual(width-8);
        const triggerBox=(await quick.boundingBox())!;
        // Overlay positioning rounds to physical pixels; allow one CSS pixel.
        expect(Math.abs(menuBox.y-triggerBox.y-triggerBox.height-6)).toBeLessThanOrEqual(1);
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('menu.png')});
        await page.getByRole('menuitem',{name:'Manage access',exact:true}).click();
        await expect(quick).toBeFocused();
        await expect(page.getByRole('status')).toHaveText('Manage access');
        await page.getByRole('button',{name:'Scope',exact:true}).click();
        await expect(page.getByTestId('spacing-picker')).toBeVisible();
        await page.getByRole('menuitemradio',{name:'All team spaces',exact:true}).click();
        await expect(page.getByRole('button',{name:'Scope',exact:true})).toContainText('All team spaces');
        const editorTrigger=page.getByRole('button',{name:'Open editor',exact:true});
        await editorTrigger.click();
        const editor=page.getByRole('dialog',{name:'Workspace editor',exact:true});
        const editorBox=(await editor.boundingBox())!;
        expect(editorBox.width).toBeLessThanOrEqual(Math.min(512,width-32));
        const insets=await editor.evaluate(el=>Array.from(el.children).map(child=>{
          const style=getComputedStyle(child);
          return [parseFloat(style.paddingLeft),parseFloat(style.paddingRight)];
        }));
        expect(insets).toEqual(Array.from({length:3},()=>[width<640?16:20,width<640?16:20]));
        await editor.getByRole('textbox',{name:'Name',exact:true}).fill('Retained draft');
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('editor.png')});
        await page.setViewportSize({width,height:360});
        const save=(await editor.getByRole('button',{name:'Save',exact:true}).boundingBox())!;
        expect(save.y).toBeGreaterThanOrEqual(0);
        expect(save.y+save.height).toBeLessThanOrEqual(360);
        expect(await editor.locator('.overflow-y-auto').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('short-editor.png')});
        await page.keyboard.press('Escape');
        await expect(editorTrigger).toBeFocused();
        await page.setViewportSize({width,height:900});
        await editorTrigger.click();
        await expect(editor.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Retained draft');
        await editor.getByRole('button',{name:'Cancel',exact:true}).click();
        await page.getByRole('button',{name:'Import custom skill',exact:true}).click();
        await page.getByTestId('skills-import-source').fill('workspace/skills/review');
        await page.getByTestId('skills-import-name').fill('Review');
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('skill.png')});
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
        await page.getByRole('button',{name:'Open navigation',exact:true}).click();
        await expect(page.getByRole('dialog',{name:'Navigation',exact:true})).toBeVisible();
        await page.screenshot({animations:'disabled',path:testInfo.outputPath('drawer.png')});
        await page.getByRole('button',{name:'Space 14',exact:true}).click();
        await expect(page.getByRole('dialog',{name:'Navigation',exact:true})).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveText('Space 14 selected');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        expect(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches)).toBe(hasTouch);
      });
    }
  });
}
