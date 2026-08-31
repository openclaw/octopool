package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func newRewritePrivateDirectory() (string, func(), error) {
	parent, closeParent, err := openRewriteWindowsPath(os.TempDir(), true)
	if err != nil {
		return "", nil, err
	}
	defer closeParent()
	var flags uint32
	if err := windows.GetVolumeInformationByHandle(windows.Handle(parent.Fd()), nil, 0, nil, nil, &flags, nil, 0); err != nil || flags&windows.FILE_PERSISTENT_ACLS == 0 {
		return "", nil, errRewriteBlocked
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", nil, err
	}
	// Set a protected, inheritable current-user-only DACL at creation, never
	// after creating a directory with permissive inherited access.
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return "", nil, err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for attempt := 0; attempt < 10; attempt++ {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", nil, err
		}
		path := filepath.Join(parent.Name(), "octopool-content-"+hex.EncodeToString(random[:]))
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return "", nil, err
		}
		if err := windows.CreateDirectory(name, &attributes); err != nil {
			if err == windows.ERROR_ALREADY_EXISTS {
				continue
			}
			return "", nil, err
		}
		file, closeFile, err := openRewriteWindowsPath(path, true)
		if err != nil {
			_ = os.Remove(path)
			return "", nil, err
		}
		if err := checkRewritePrivateWindowsDirectory(file, user.User.Sid); err != nil {
			closeFile()
			_ = os.Remove(path)
			return "", nil, err
		}
		return path, closeFile, nil
	}
	return "", nil, errRewriteBlocked
}

func checkRewritePrivateWindowsDirectory(file *os.File, sid *windows.SID) error {
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || !windows.EqualSid(owner, sid) {
		return errRewriteBlocked
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errRewriteBlocked
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return errRewriteBlocked
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		return err
	}
	// FILE_ALL_ACCESS from WinNT.h (all nine file-specific access rights).
	const fileAllAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE || ace.Mask != fileAllAccess || !windows.EqualSid((*windows.SID)(unsafe.Pointer(&ace.SidStart)), sid) {
		return errRewriteBlocked
	}
	return nil
}
