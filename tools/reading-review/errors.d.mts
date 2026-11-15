export function toolError(code:string,message:string,details?:any):Error&{code:string;details:any}
export function errorRecord(error:any,stage:string):any
export function commandErrorMessage(stdout:string,stderr:string,fallback:string):string
export function saveCommandLog(folder:string|undefined,name:string,args:string[],result:any,startedAt:string):Promise<any>
