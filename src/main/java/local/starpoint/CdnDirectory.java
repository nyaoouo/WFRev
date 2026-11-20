package local.starpoint;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import java.io.File;
import java.io.IOException;

final class CdnDirectory {
    static final String PREFERENCES = "starpoint-offline";
    static final String LOCATION = "cdn-directory";
    private static final String STORAGE_PROVIDER = "com.android.externalstorage.documents";

    static String savedLocation(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .getString(LOCATION, null);
    }

    static File fromTree(Context context, Uri tree) throws IOException {
        File selected = sharedDirectoryFromTree(context, tree);
        return "cn".equals(selected.getName()) ? selected.getParentFile() : selected;
    }

    static File sharedDirectoryFromTree(Context context, Uri tree) throws IOException {
        if (!STORAGE_PROVIDER.equals(tree.getAuthority()) || !DocumentsContract.isTreeUri(tree)) {
            throw new IOException("请选择手机存储或 SD 卡里的本地目录。");
        }
        String[] id = DocumentsContract.getTreeDocumentId(tree).split(":", 2);
        if (id.length != 2 || id[1].isEmpty()) throw new IOException("请选择存储空间中的子文件夹。");
        StorageManager storage = context.getSystemService(StorageManager.class);
        for (StorageVolume volume : storage.getStorageVolumes()) {
            boolean matches = volume.isPrimary() ? "primary".equals(id[0])
                    : id[0].equalsIgnoreCase(volume.getUuid());
            if (!matches) continue;
            File directory = Build.VERSION.SDK_INT >= 30 ? volume.getDirectory()
                    : volume.isPrimary() ? Environment.getExternalStorageDirectory() : null;
            if (directory == null) continue;
            File root = directory.getCanonicalFile();
            File selected = new File(root, id[1]).getCanonicalFile();
            if (!selected.getPath().startsWith(root.getPath() + File.separator)) {
                throw new IOException("选择的目录超出该存储空间。");
            }
            return selected;
        }
        throw new IOException("找不到目录所在的存储空间。");
    }

    static File validate(File parent) throws IOException {
        File resolved = parent.getCanonicalFile();
        File cn = new File(resolved, "cn");
        File archives = new File(cn, "archive-common-full");
        String[] zips = archives.list((directory, name) -> name.endsWith(".zip"));
        if (zips == null || zips.length == 0) {
            throw new IOException("没有读到 cn/archive-common-full 中的 ZIP 归档。请选择解压后的 cn 或其上一级目录。");
        }
        if (!new File(cn, "entities").isDirectory() && !new File(cn, "EntityLists").isDirectory()) {
            throw new IOException("CDN 缺少 cn/entities 或 cn/EntityLists。");
        }
        return resolved;
    }
}
