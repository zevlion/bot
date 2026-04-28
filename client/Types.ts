export interface Command {
  pattern?: string;
  alias?: string[];
  fromMe?: boolean;
  isGroup?: boolean;
  func: () => Promise<any | void>;
}
